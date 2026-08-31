import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

import { translateMessages } from "./translation.ts";
import type { SessionSnapshot, SessionStatus, ShimConfig } from "./types.ts";

export interface CreateSessionInput {
  readonly cwd: string;
  readonly id: string;
}

export interface BackendSession {
  readonly id: string;
  snapshot(): SessionSnapshot;
  abort(): Promise<void>;
  dispose(): void;
}

export interface SessionBackend {
  createSession(input: CreateSessionInput): Promise<BackendSession>;
  listSessions(): Promise<readonly SessionSnapshot[]>;
  openSession(id: string): Promise<BackendSession | null>;
}

function now(): number {
  return Date.now();
}

class MemoryBackendSession implements BackendSession {
  private readonly created: number;
  private status: SessionStatus = "idle";
  private updated: number;

  constructor(
    public readonly id: string,
    private readonly cwd: string
  ) {
    this.created = now();
    this.updated = this.created;
  }

  snapshot(): SessionSnapshot {
    return {
      cwd: this.cwd,
      id: this.id,
      messages: [],
      status: this.status,
      time: { created: this.created, updated: this.updated },
    };
  }

  async abort(): Promise<void> {
    this.status = "aborted";
    this.updated = now();
  }

  dispose(): void {}
}

export class InMemorySessionBackend implements SessionBackend {
  private readonly sessions = new Map<string, MemoryBackendSession>();

  async createSession(input: CreateSessionInput): Promise<BackendSession> {
    const session = new MemoryBackendSession(input.id, input.cwd);
    this.sessions.set(input.id, session);
    return session;
  }

  async listSessions(): Promise<readonly SessionSnapshot[]> {
    return [...this.sessions.values()].map((session) => session.snapshot());
  }

  async openSession(id: string): Promise<BackendSession | null> {
    return this.sessions.get(id) ?? null;
  }
}

class PiBackendSession implements BackendSession {
  private readonly created = now();
  private status: SessionStatus = "idle";

  constructor(
    public readonly id: string,
    private readonly session: AgentSession,
    private readonly cwd: string
  ) {}

  snapshot(): SessionSnapshot {
    return {
      cwd: this.cwd,
      id: this.id,
      messages: translateMessages(this.id, this.session.messages),
      status: this.session.isStreaming ? "running" : this.status,
      time: { created: this.created, updated: now() },
    };
  }

  async abort(): Promise<void> {
    await this.session.abort();
    this.status = "aborted";
  }

  dispose(): void {
    this.session.dispose();
  }
}

export class PiSessionBackend implements SessionBackend {
  constructor(private readonly config: ShimConfig) {}

  private async createPiSession(
    input: CreateSessionInput,
    manager: SessionManager
  ): Promise<BackendSession> {
    const options: CreateAgentSessionOptions = {
      cwd: input.cwd,
      sessionManager: manager,
    };
    if (this.config.agentDir !== undefined)
      options.agentDir = this.config.agentDir;
    const result = await createAgentSession(options);
    return new PiBackendSession(input.id, result.session, input.cwd);
  }

  async createSession(input: CreateSessionInput): Promise<BackendSession> {
    const manager = SessionManager.create(input.cwd, this.config.sessionDir, {
      id: input.id,
    });
    return this.createPiSession(input, manager);
  }

  async listSessions(): Promise<readonly SessionSnapshot[]> {
    const sessions = await SessionManager.listAll(this.config.sessionDir);
    return sessions.map((session) => ({
      cwd: session.cwd,
      id: session.id,
      messages: [],
      status: "idle",
      time: {
        created: session.created.getTime(),
        updated: session.modified.getTime(),
      },
    }));
  }

  async openSession(id: string): Promise<BackendSession | null> {
    const sessions = await SessionManager.listAll(this.config.sessionDir);
    const info = sessions.find((session) => session.id === id);
    if (info === undefined) return null;
    const manager = SessionManager.open(
      info.path,
      this.config.sessionDir,
      info.cwd
    );
    return this.createPiSession({ cwd: info.cwd, id: info.id }, manager);
  }
}

export class SessionRegistry {
  private readonly active = new Map<string, BackendSession>();

  constructor(private readonly backend: SessionBackend) {}

  async createSession(
    input: Omit<CreateSessionInput, "id"> & { readonly id?: string }
  ): Promise<SessionSnapshot> {
    const id = input.id ?? crypto.randomUUID();
    if (this.active.has(id) || (await this.backend.openSession(id)) !== null) {
      throw new Error(`Session ${id} already exists`);
    }
    const session = await this.backend.createSession({ cwd: input.cwd, id });
    this.active.set(id, session);
    return session.snapshot();
  }

  async getSession(id: string): Promise<BackendSession | null> {
    const active = this.active.get(id);
    if (active !== undefined) return active;
    const reopened = await this.backend.openSession(id);
    if (reopened !== null) this.active.set(id, reopened);
    return reopened;
  }

  async getSnapshot(id: string): Promise<SessionSnapshot | null> {
    const session = await this.getSession(id);
    return session?.snapshot() ?? null;
  }

  async listSessions(): Promise<readonly SessionSnapshot[]> {
    const sessions = new Map(
      (await this.backend.listSessions()).map((session) => [
        session.id,
        session,
      ])
    );
    for (const [id, session] of this.active)
      sessions.set(id, session.snapshot());
    return [...sessions.values()];
  }

  async dispose(): Promise<void> {
    for (const session of this.active.values()) session.dispose();
    this.active.clear();
  }
}
