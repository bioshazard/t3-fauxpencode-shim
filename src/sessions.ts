import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

import {
  translateAgentEvent,
  translateMessages,
  type TranslationIdentity,
} from "./translation.ts";
import type {
  FacadeMessage,
  JsonValue,
  PromptInput,
  SessionEventSink,
  SessionSnapshot,
  SessionStatus,
  ShimConfig,
} from "./types.ts";

export interface CreateSessionInput {
  readonly cwd: string;
  readonly id: string;
  readonly permission?: readonly JsonValue[];
  readonly title?: string;
}

export interface BackendSession {
  readonly id: string;
  snapshot(): SessionSnapshot;
  prompt(
    input: PromptInput | string,
    emit: SessionEventSink
  ): Promise<SessionSnapshot>;
  abort(): Promise<void>;
  update(permission: readonly JsonValue[] | undefined): Promise<void>;
  revert(messageId: string): Promise<SessionSnapshot | null>;
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

function normalizePromptInput(input: PromptInput | string): PromptInput {
  return Object.prototype.toString.call(input) === "[object String]"
    ? { images: [], text: String(input) }
    : (input as PromptInput);
}

const MESSAGE_ID_ENTRY_TYPE = "pi-opencode-shim-message-id";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || Array.isArray(value)) return null;
  return Object.prototype.toString.call(value) === "[object Object]"
    ? (value as Record<string, unknown>)
    : null;
}

function readStringField(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = record[key];
  return Object.prototype.toString.call(value) === "[object String]"
    ? String(value)
    : null;
}

class MemoryBackendSession implements BackendSession {
  private readonly created: number;
  private readonly messages: FacadeMessage[] = [];
  private activeEmit: SessionEventSink | undefined;
  private abortRequested = false;
  private promptTail: Promise<void> = Promise.resolve();
  private status: SessionStatus = "idle";
  private updated: number;

  constructor(
    public readonly id: string,
    private readonly cwd: string,
    private readonly title: string,
    private permission: readonly JsonValue[]
  ) {
    this.created = now();
    this.updated = this.created;
  }

  snapshot(): SessionSnapshot {
    return {
      cwd: this.cwd,
      id: this.id,
      messages: [...this.messages],
      permission: [...this.permission],
      status: this.status,
      title: this.title,
      time: { created: this.created, updated: this.updated },
    };
  }

  prompt(
    input: PromptInput | string,
    emit: SessionEventSink
  ): Promise<SessionSnapshot> {
    const normalized = normalizePromptInput(input);
    const operation = this.promptTail.then(() =>
      this.runPrompt(normalized, emit)
    );
    this.promptTail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async runPrompt(
    input: PromptInput,
    emit: SessionEventSink
  ): Promise<SessionSnapshot> {
    if (this.abortRequested) {
      this.abortRequested = false;
      this.status = "aborted";
      this.activeEmit = emit;
      emitStatus(this.id, this.status, emit);
      this.activeEmit = undefined;
      return this.snapshot();
    }
    this.status = "running";
    this.activeEmit = emit;
    this.updated = now();
    emitStatus(this.id, this.status, emit);

    const user: FacadeMessage = {
      id: input.messageId ?? `${this.id}-message-${this.messages.length + 1}`,
      parts: [{ text: input.text, type: "text" }],
      role: "user",
      time: { created: now() },
    };
    this.messages.push(user);
    emitMessage(this.id, "message.created", user, emit);

    if (input.text.startsWith("tool:")) {
      const toolName = input.text.slice("tool:".length).trim() || "demo_tool";
      const toolCallId = `${this.id}-tool-${this.messages.length}`;
      const assistant: FacadeMessage = {
        id: `${this.id}-message-${this.messages.length + 1}`,
        parts: [
          {
            id: toolCallId,
            input: { value: toolName },
            name: toolName,
            type: "tool-call",
          },
        ],
        role: "assistant",
        time: { completed: now(), created: now() },
      };
      this.messages.push(assistant);
      emitMessage(this.id, "message.completed", assistant, emit);
      emit({
        id: crypto.randomUUID(),
        properties: { toolCallId, toolName },
        sessionID: this.id,
        type: "tool.started",
      });
      await Promise.resolve();
      if (this.wasAborted()) return this.snapshot();
      const result: FacadeMessage = {
        id: `${this.id}-message-${this.messages.length + 1}`,
        parts: [
          {
            error: false,
            text: `${toolName} ok`,
            toolCallId,
            type: "tool-result",
          },
        ],
        role: "tool",
        time: { completed: now(), created: now() },
      };
      this.messages.push(result);
      emitMessage(this.id, "message.completed", result, emit);
      emit({
        id: crypto.randomUUID(),
        properties: { isError: false, toolCallId, toolName },
        sessionID: this.id,
        type: "tool.completed",
      });
      this.status = "idle";
      this.updated = now();
      emitStatus(this.id, this.status, emit);
      return this.snapshot();
    }

    let partial = "";
    for (const delta of ["Echo: ", input.text]) {
      await Promise.resolve();
      if (this.wasAborted()) return this.snapshot();
      partial += delta;
      emit({
        id: crypto.randomUUID(),
        properties: {
          delta,
          messageId: `${this.id}-message-${this.messages.length + 1}`,
        },
        sessionID: this.id,
        type: "message.part.updated",
      });
    }

    const assistant: FacadeMessage = {
      id: `${this.id}-message-${this.messages.length + 1}`,
      parts: [{ text: partial, type: "text" }],
      role: "assistant",
      time: { completed: now(), created: now() },
    };
    this.messages.push(assistant);
    emitMessage(this.id, "message.completed", assistant, emit);
    this.status = "idle";
    this.updated = now();
    emitStatus(this.id, this.status, emit);
    return this.snapshot();
  }

  private wasAborted(): boolean {
    return this.status === "aborted";
  }

  async abort(): Promise<void> {
    if (this.status !== "running") {
      this.abortRequested = true;
      this.status = "aborted";
      this.updated = now();
      return;
    }
    this.status = "aborted";
    this.updated = now();
    this.activeEmit?.({
      id: crypto.randomUUID(),
      properties: { sessionStatus: this.status },
      sessionID: this.id,
      type: "session.status",
    });
  }

  async update(permission: readonly JsonValue[] | undefined): Promise<void> {
    if (permission !== undefined) this.permission = [...permission];
  }

  async revert(messageId: string): Promise<SessionSnapshot | null> {
    const index = this.messages.findIndex(
      (message) => message.id === messageId
    );
    if (index < 0) return null;
    this.messages.splice(index);
    this.status = "idle";
    this.updated = now();
    return this.snapshot();
  }

  dispose(): void {
    this.activeEmit = undefined;
  }
}

function emitStatus(
  id: string,
  status: SessionStatus,
  emit: SessionEventSink
): void {
  emit({
    id: crypto.randomUUID(),
    properties: {
      sessionID: id,
      sessionStatus: status,
      status: { type: status === "running" ? "busy" : "idle" },
    },
    sessionID: id,
    type: "session.status",
  });
}

function emitMessage(
  id: string,
  type: string,
  message: FacadeMessage,
  emit: SessionEventSink
): void {
  emit({
    id: crypto.randomUUID(),
    properties: { message, messageId: message.id },
    sessionID: id,
    type,
  });
}

export class InMemorySessionBackend implements SessionBackend {
  private readonly sessions = new Map<string, MemoryBackendSession>();

  async createSession(input: CreateSessionInput): Promise<BackendSession> {
    const session = new MemoryBackendSession(
      input.id,
      input.cwd,
      input.title ?? `Pi session ${input.id}`,
      input.permission ?? []
    );
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
  private readonly created: number;
  private readonly messageIdOverrides = new Map<AgentMessage, string>();
  private readonly persistedMessageEntryIds = new Set<string>();
  private activeEmit: SessionEventSink | undefined;
  private abortRequested = false;
  private promptTail: Promise<void> = Promise.resolve();
  private status: SessionStatus = "idle";

  constructor(
    public readonly id: string,
    private readonly session: AgentSession,
    private readonly cwd: string,
    private readonly title: string,
    private permission: readonly JsonValue[],
    private readonly identity: TranslationIdentity
  ) {
    const header = session.sessionManager.getHeader();
    this.created = header === null ? now() : Date.parse(header.timestamp);
    this.restoreMessageIdOverrides();
  }

  private restoreMessageIdOverrides(): void {
    const manager = this.session.sessionManager;
    for (const entry of manager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== MESSAGE_ID_ENTRY_TYPE)
        continue;
      const data = asRecord(entry.data);
      if (data === null) {
        continue;
      }
      const messageEntryId = readStringField(data, "messageEntryId");
      const facadeId = readStringField(data, "facadeId");
      if (messageEntryId === null || facadeId === null) continue;
      const messageEntry = manager.getEntry(messageEntryId);
      if (messageEntry?.type !== "message") continue;
      const message = this.session.messages.find(
        (candidate) =>
          candidate === messageEntry.message ||
          (candidate.role === messageEntry.message.role &&
            candidate.timestamp === messageEntry.message.timestamp)
      );
      if (message !== undefined) {
        this.messageIdOverrides.set(message, facadeId);
        this.persistedMessageEntryIds.add(messageEntryId);
      }
    }
  }

  private currentIdentity(): TranslationIdentity {
    const model = this.session.model;
    return {
      agent: this.identity.agent,
      modelId: model?.id ?? this.identity.modelId,
      providerId: model?.provider ?? this.identity.providerId,
    };
  }

  snapshot(): SessionSnapshot {
    return {
      cwd: this.cwd,
      id: this.id,
      messages: translateMessages(
        this.id,
        this.session.messages,
        this.messageIdOverrides
      ),
      permission: [...this.permission],
      status: this.session.isStreaming ? "running" : this.status,
      title: this.title,
      time: { created: this.created, updated: now() },
    };
  }

  prompt(
    input: PromptInput | string,
    emit: SessionEventSink
  ): Promise<SessionSnapshot> {
    const normalized = normalizePromptInput(input);
    const operation = this.promptTail.then(() =>
      this.runPrompt(normalized, emit)
    );
    this.promptTail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async runPrompt(
    input: PromptInput,
    emit: SessionEventSink
  ): Promise<SessionSnapshot> {
    if (this.abortRequested) {
      this.abortRequested = false;
      this.status = "aborted";
      this.activeEmit = emit;
      emitStatus(this.id, this.status, emit);
      this.activeEmit = undefined;
      return this.snapshot();
    }
    this.status = "running";
    this.activeEmit = emit;
    const promptMessageIndex = this.session.messages.length;
    const rememberPromptMessage = (): void => {
      if (input.messageId === undefined) return;
      const message = this.session.messages[promptMessageIndex];
      if (message?.role !== "user") return;
      this.messageIdOverrides.set(message, input.messageId);
      const messageEntry = this.session.sessionManager
        .getEntries()
        .find(
          (entry) =>
            entry.type === "message" &&
            (entry.message === message ||
              (entry.message.role === message.role &&
                entry.message.timestamp === message.timestamp))
        );
      if (
        messageEntry !== undefined &&
        !this.persistedMessageEntryIds.has(messageEntry.id)
      ) {
        this.session.sessionManager.appendCustomEntry(MESSAGE_ID_ENTRY_TYPE, {
          facadeId: input.messageId,
          messageEntryId: messageEntry.id,
        });
        this.persistedMessageEntryIds.add(messageEntry.id);
      }
    };
    emitStatus(this.id, this.status, emit);
    const messageIds = new Map<string, string>();
    const unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
      if (
        input.messageId !== undefined &&
        (event.type === "message_start" || event.type === "message_end") &&
        event.message.role === "user"
      ) {
        this.messageIdOverrides.set(event.message, input.messageId);
      }
      for (const translated of translateAgentEvent(
        this.id,
        event,
        this.session.messages,
        messageIds,
        this.messageIdOverrides,
        this.currentIdentity()
      )) {
        emit(translated);
      }
    });
    try {
      if (input.model !== undefined) {
        const model = this.session.modelRuntime.getModel(
          input.model.providerId,
          input.model.modelId
        );
        if (model !== undefined) await this.session.setModel(model);
      }
      const images =
        input.images.length === 0
          ? undefined
          : input.images.map((image) => ({
              data: image.data,
              mimeType: image.mimeType,
              type: "image" as const,
            }));
      await this.session.prompt(
        input.text,
        images === undefined ? undefined : { images }
      );
      rememberPromptMessage();
      if (!this.wasAborted()) this.status = "idle";
      emitStatus(this.id, this.status, emit);
      return this.snapshot();
    } catch (error) {
      this.status = this.wasAborted() ? "aborted" : "error";
      emit({
        id: crypto.randomUUID(),
        properties: {
          error: error instanceof Error ? error.message : "Pi prompt failed.",
          sessionStatus: this.status,
        },
        sessionID: this.id,
        type: "session.error",
      });
      throw error;
    } finally {
      rememberPromptMessage();
      unsubscribe();
      if (this.activeEmit === emit) this.activeEmit = undefined;
    }
  }

  private wasAborted(): boolean {
    return this.status === "aborted";
  }

  async abort(): Promise<void> {
    if (!this.session.isStreaming) {
      this.abortRequested = true;
      this.status = "aborted";
      if (this.activeEmit !== undefined)
        emitStatus(this.id, this.status, this.activeEmit);
      return;
    }
    await this.session.abort();
    this.status = "aborted";
    if (this.activeEmit !== undefined)
      emitStatus(this.id, this.status, this.activeEmit);
  }

  async update(permission: readonly JsonValue[] | undefined): Promise<void> {
    if (permission !== undefined) this.permission = [...permission];
  }

  async revert(messageId: string): Promise<SessionSnapshot | null> {
    const match = /-message-(\d+)$/u.exec(messageId);
    const ordinal = match === null ? Number.NaN : Number(match[1]);
    if (!Number.isInteger(ordinal) || ordinal < 1) return null;
    const messageEntries = this.session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "message");
    const target = messageEntries[ordinal - 1];
    if (target === undefined) return null;
    await this.session.navigateTree(target.parentId ?? target.id);
    this.status = "idle";
    return this.snapshot();
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
    return new PiBackendSession(
      input.id,
      result.session,
      input.cwd,
      input.title ?? `Pi session ${input.id}`,
      input.permission ?? [],
      {
        agent: "pi",
        modelId: this.config.modelId,
        providerId: this.config.providerId,
      }
    );
  }

  async createSession(input: CreateSessionInput): Promise<BackendSession> {
    const manager = SessionManager.create(input.cwd, this.config.sessionDir, {
      id: input.id,
    });
    const session = await this.createPiSession(input, manager);
    manager.appendCustomEntry("pi-opencode-shim", { facadeId: input.id });
    return session;
  }

  async listSessions(): Promise<readonly SessionSnapshot[]> {
    const sessions = await SessionManager.listAll(this.config.sessionDir);
    return sessions.map((session) => ({
      cwd: session.cwd,
      id: session.id,
      messages: [],
      permission: [],
      status: "idle",
      title: `Pi session ${session.id}`,
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
    return this.createPiSession(
      {
        cwd: info.cwd,
        id: info.id,
        permission: [],
        title: `Pi session ${info.id}`,
      },
      manager
    );
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
    const session = await this.backend.createSession({
      cwd: input.cwd,
      id,
      ...(input.permission === undefined
        ? {}
        : { permission: input.permission }),
      ...(input.title === undefined ? {} : { title: input.title }),
    });
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

  async promptSession(
    id: string,
    input: PromptInput | string,
    emit: SessionEventSink
  ): Promise<SessionSnapshot | null> {
    const session = await this.getSession(id);
    return session === null ? null : session.prompt(input, emit);
  }

  async abortSession(id: string): Promise<SessionSnapshot | null> {
    const session = await this.getSession(id);
    if (session === null) return null;
    await session.abort();
    return session.snapshot();
  }

  async updateSession(
    id: string,
    permission: readonly JsonValue[] | undefined
  ): Promise<SessionSnapshot | null> {
    const session = await this.getSession(id);
    if (session === null) return null;
    await session.update(permission);
    return session.snapshot();
  }

  async revertSession(
    id: string,
    messageId: string
  ): Promise<SessionSnapshot | null> {
    const session = await this.getSession(id);
    return session === null ? null : session.revert(messageId);
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
