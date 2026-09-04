import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { ActiveDirectoryTracker } from "./active-directory.ts";
import { canonicalAllowedCwd, loadConfig, normalizeConfig } from "./config.ts";
import { contractError } from "./contract.ts";
import { EventHub } from "./events.ts";
import { createRequestLogger } from "./logging.ts";
import {
  messagesResponse,
  providerResponse,
  sessionResponse,
  type PiAvailableModel,
} from "./opencode.ts";
import {
  readCreateSessionRequest,
  readPromptRequest,
  readRevertRequest,
  readSessionUpdateRequest,
} from "./request.ts";
import {
  InMemorySessionBackend,
  PiSessionBackend,
  SessionRegistry,
} from "./sessions.ts";
import type {
  FacadeMessage,
  ErrorResponse,
  HealthResponse,
  JsonValue,
  ProviderResponse,
  SessionSnapshot,
  ShimConfig,
} from "./types.ts";

type ResponseBody =
  | ErrorResponse
  | FacadeMessage
  | HealthResponse
  | JsonValue
  | ProviderResponse
  | SessionSnapshot
  | readonly FacadeMessage[]
  | readonly SessionSnapshot[];

// Bun closes inactive requests after 10 seconds by default; T3 keeps /event open.
export const SSE_IDLE_TIMEOUT_SECONDS = 0;

function jsonResponse(body: ResponseBody, status = 200): Response {
  return Response.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });
}

function methodNotAllowed(request: Request): Response {
  return jsonResponse(
    contractError(
      "method_not_allowed",
      `Method ${request.method} is not supported for ${new URL(request.url).pathname}`
    ),
    405
  );
}

function isAssistantMessageEntry(entry: { readonly info: JsonValue }): boolean {
  if (Object.prototype.toString.call(entry.info) !== "[object Object]") {
    return false;
  }
  const info = entry.info as { readonly role?: JsonValue };
  return info.role === "assistant";
}

async function discoverPiSkills(
  config: ShimConfig
): Promise<readonly JsonValue[]> {
  const agentDir = config.agentDir ?? getAgentDir();
  const loader = new DefaultResourceLoader({
    agentDir,
    cwd: config.cwd,
    settingsManager: SettingsManager.create(config.cwd, agentDir),
  });
  await loader.reload();
  const skills = loader.getSkills().skills;
  return Promise.all(
    skills.map(async (skill) => {
      try {
        return {
          content: await readFile(skill.filePath, "utf8"),
          description: skill.description,
          location: skill.filePath,
          name: skill.name,
        };
      } catch {
        return null;
      }
    })
  ).then((items) => items.filter((item) => item !== null));
}

/** Enumerate the models the local pi installation can actually use. */
async function discoverPiModels(
  config: ShimConfig
): Promise<readonly PiAvailableModel[]> {
  try {
    const runtime = await ModelRuntime.create({
      refreshOnCreate: false,
      ...(config.agentDir === undefined
        ? {}
        : {
            authPath: resolve(config.agentDir, "auth.json"),
            modelsPath: resolve(config.agentDir, "models.json"),
          }),
    });
    const registry = new ModelRegistry(runtime);
    await registry.refresh();
    return registry.getAvailable();
  } catch (error) {
    console.error(
      `pi model discovery failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return [];
  }
}

export function createHandler(
  config: ShimConfig,
  sessions = new SessionRegistry(new InMemorySessionBackend()),
  events = new EventHub()
): (request: Request) => Response | Promise<Response> {
  return createSessionHandler(normalizeConfig(config), sessions, events);
}

function notFound(): Response {
  return jsonResponse(
    contractError("unknown_session", "The requested session does not exist."),
    404
  );
}

function createSessionHandler(
  config: ShimConfig,
  sessions: SessionRegistry,
  events: EventHub
): (request: Request) => Response | Promise<Response> {
  const piSkillDiscovery = discoverPiSkills(config);
  const piModelDiscovery = discoverPiModels(config);
  // T3 omits cwd on POST /session. It sends the selected project directory on
  // its health probe before creating the session, then confirms it on /event.
  // Do not fall back to the launch directory: that would run in the wrong repo.
  const activeDirectories = new ActiveDirectoryTracker();
  const trackProjectDirectory = (url: URL): void => {
    const directory = url.searchParams.get("directory");
    if (directory === null || directory.length === 0) return;
    const canonicalDirectory = canonicalAllowedCwd(
      directory,
      config.allowedRoots
    );
    if (canonicalDirectory !== null)
      activeDirectories.record(canonicalDirectory);
  };

  return (request) => {
    const url = new URL(request.url);

    if (url.pathname === "/global/health") {
      if (request.method !== "GET") return methodNotAllowed(request);
      trackProjectDirectory(url);
      return jsonResponse({
        healthy: true,
        service: "pi-opencode-server",
        version: config.version,
      });
    }

    if (url.pathname === "/provider") {
      if (request.method !== "GET") return methodNotAllowed(request);
      return piModelDiscovery.then((models) =>
        jsonResponse(providerResponse(config, models))
      );
    }

    if (
      url.pathname === "/agent" ||
      url.pathname === "/permission" ||
      url.pathname === "/question"
    ) {
      if (request.method !== "GET") return methodNotAllowed(request);
      return jsonResponse([]);
    }

    if (url.pathname === "/skill") {
      if (request.method !== "GET") return methodNotAllowed(request);
      return piSkillDiscovery.then((skills) => jsonResponse(skills));
    }

    if (url.pathname === "/global/event" || url.pathname === "/event") {
      if (request.method !== "GET") return methodNotAllowed(request);
      trackProjectDirectory(url);
      return events.response();
    }

    if (url.pathname === "/session" && request.method === "POST") {
      return readCreateSessionRequest(
        request,
        activeDirectories.current()
      ).then(async (parsed) => {
        if (parsed.kind === "error") {
          return jsonResponse(
            contractError("invalid_request", parsed.message),
            400
          );
        }
        if (parsed.kind === "missing_cwd") {
          return jsonResponse(
            contractError(
              "cwd_required",
              "An explicit session cwd or an allowed T3 project directory is required."
            ),
            409
          );
        }
        const canonicalCwd = canonicalAllowedCwd(
          parsed.input.cwd,
          config.allowedRoots
        );
        if (canonicalCwd === null) {
          return jsonResponse(
            contractError(
              "cwd_not_allowed",
              "The requested session cwd is outside the configured roots."
            ),
            403
          );
        }
        try {
          return jsonResponse(
            sessionResponse(
              await sessions.createSession({
                ...parsed.input,
                cwd: canonicalCwd,
              }),
              config
            )
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Session creation failed.";
          return jsonResponse(contractError("session_exists", message), 409);
        }
      });
    }

    if (url.pathname === "/session" && request.method === "GET") {
      return sessions
        .listSessions()
        .then((items) =>
          jsonResponse(items.map((item) => sessionResponse(item, config)))
        );
    }

    if (url.pathname === "/session/status") {
      if (request.method !== "GET") return methodNotAllowed(request);
      return sessions
        .listSessions()
        .then((items) =>
          jsonResponse(
            Object.fromEntries(
              items.map((item) => [
                item.id,
                { type: item.status === "running" ? "busy" : "idle" },
              ])
            )
          )
        );
    }

    if (url.pathname === "/session") return methodNotAllowed(request);

    const sessionUpdatePath = /^\/session\/([^/]+)$/u.exec(url.pathname);
    if (sessionUpdatePath !== null && request.method === "PATCH") {
      const sessionId = decodeURIComponent(sessionUpdatePath[1] ?? "");
      return readSessionUpdateRequest(request).then(async (parsed) => {
        if (parsed.kind === "error")
          return jsonResponse(
            contractError("invalid_request", parsed.message),
            400
          );
        const snapshot = await sessions.updateSession(
          sessionId,
          parsed.permission
        );
        return snapshot === null
          ? notFound()
          : jsonResponse(sessionResponse(snapshot, config));
      });
    }

    const sessionPath =
      /^\/session\/([^/]+)(\/message|\/prompt|\/prompt_async|\/abort|\/revert|\/event)?$/u.exec(
        url.pathname
      );
    const messagePath = /^\/session\/([^/]+)\/message\/([^/]+)$/u.exec(
      url.pathname
    );
    if (messagePath !== null) {
      if (request.method !== "GET") return methodNotAllowed(request);
      const sessionId = decodeURIComponent(messagePath[1] ?? "");
      const messageId = decodeURIComponent(messagePath[2] ?? "");
      return sessions.getSnapshot(sessionId).then((snapshot) => {
        if (snapshot === null) return notFound();
        const entry = messagesResponse(snapshot, config).find((candidate) => {
          const info = candidate.info;
          if (Object.prototype.toString.call(info) !== "[object Object]") {
            return false;
          }
          const record = info as { readonly id?: JsonValue };
          return record.id === messageId;
        });
        return entry === undefined ? notFound() : jsonResponse(entry);
      });
    }
    if (sessionPath !== null) {
      const sessionId = decodeURIComponent(sessionPath[1] ?? "");
      const operation = sessionPath[2];
      if (request.method === "GET" && operation === "/event") {
        return events.response(sessionId);
      }
      if (
        request.method === "POST" &&
        (operation === "/message" || operation === "/prompt")
      ) {
        return readPromptRequest(request).then(async (parsed) => {
          if (parsed.kind === "error") {
            return jsonResponse(
              contractError("invalid_request", parsed.message),
              400
            );
          }
          try {
            const snapshot = await sessions.promptSession(
              sessionId,
              parsed.input,
              (event) => events.publish(event)
            );
            if (snapshot === null) return notFound();
            const entries = messagesResponse(snapshot, config);
            const assistant = [...entries]
              .reverse()
              .find(isAssistantMessageEntry);
            return jsonResponse(assistant ?? sessionResponse(snapshot, config));
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Pi prompt failed.";
            return jsonResponse(contractError("session_failed", message), 500);
          }
        });
      }
      if (request.method === "POST" && operation === "/prompt_async") {
        return readPromptRequest(request).then(async (parsed) => {
          if (parsed.kind === "error") {
            return jsonResponse(
              contractError("invalid_request", parsed.message),
              400
            );
          }
          const session = await sessions.getSession(sessionId);
          if (session === null) return notFound();
          void sessions
            .promptSession(sessionId, parsed.input, (event) =>
              events.publish(event)
            )
            .catch((error: unknown) => {
              events.publish({
                id: crypto.randomUUID(),
                properties: {
                  error:
                    error instanceof Error
                      ? error.message
                      : "Pi prompt failed.",
                  sessionStatus: "error",
                },
                sessionID: sessionId,
                type: "session.error",
              });
            });
          return new Response(null, {
            headers: { "cache-control": "no-store" },
            status: 204,
          });
        });
      }
      if (request.method === "POST" && operation === "/abort") {
        return sessions
          .abortSession(sessionId)
          .then((snapshot) =>
            snapshot === null ? notFound() : jsonResponse(true)
          );
      }
      if (request.method === "POST" && operation === "/revert") {
        return readRevertRequest(request).then(async (parsed) => {
          if (parsed.kind === "error") {
            return jsonResponse(
              contractError("invalid_request", parsed.message),
              400
            );
          }
          try {
            const snapshot = await sessions.revertSession(
              sessionId,
              parsed.messageId
            );
            return snapshot === null
              ? notFound()
              : jsonResponse(sessionResponse(snapshot, config));
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Session revert failed.";
            return jsonResponse(contractError("session_failed", message), 500);
          }
        });
      }
      if (request.method !== "GET") return methodNotAllowed(request);
      return sessions.getSnapshot(sessionId).then((snapshot) => {
        if (snapshot === null) return notFound();
        return jsonResponse(
          operation === "/message"
            ? messagesResponse(snapshot, config)
            : sessionResponse(snapshot, config)
        );
      });
    }

    return jsonResponse(
      contractError(
        "unknown_route",
        `No contract for ${request.method} ${url.pathname}`
      ),
      404
    );
  };
}

export function runServer(
  config: ShimConfig = loadConfig()
): Bun.Server<undefined> {
  const normalizedConfig = normalizeConfig(config);
  const sessions = new SessionRegistry(new PiSessionBackend(normalizedConfig));
  const events = new EventHub();
  const handler = createSessionHandler(normalizedConfig, sessions, events);
  const logger = createRequestLogger((entry) =>
    console.log(JSON.stringify(entry))
  );
  const server = Bun.serve({
    fetch(request) {
      const response = Promise.resolve(handler(request));
      logger.log(request, response, performance.now());
      return response;
    },
    hostname: normalizedConfig.host,
    idleTimeout: SSE_IDLE_TIMEOUT_SECONDS,
    port: normalizedConfig.port,
  });
  console.log(`pi-opencode-server listening on ${server.url}`);
  return server;
}

if (import.meta.main) runServer();
