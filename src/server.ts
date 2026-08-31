import { loadConfig } from "./config.ts";
import { contractError } from "./contract.ts";
import { EventHub } from "./events.ts";
import {
  messagesResponse,
  providerResponse,
  sessionResponse,
} from "./opencode.ts";
import {
  readCreateSessionRequest,
  readPromptRequest,
  readRevertRequest,
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

export function createHandler(
  config: ShimConfig,
  sessions = new SessionRegistry(new InMemorySessionBackend()),
  events = new EventHub()
): (request: Request) => Response | Promise<Response> {
  return createSessionHandler(config, sessions, events);
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
  return (request) => {
    const url = new URL(request.url);

    if (url.pathname === "/global/health") {
      if (request.method !== "GET") return methodNotAllowed(request);
      return jsonResponse({
        healthy: true,
        service: "pi-opencode-server",
        version: config.version,
      });
    }

    if (url.pathname === "/provider") {
      if (request.method !== "GET") return methodNotAllowed(request);
      return jsonResponse(providerResponse(config));
    }

    if (url.pathname === "/agent" || url.pathname === "/skill") {
      if (request.method !== "GET") return methodNotAllowed(request);
      return jsonResponse([]);
    }

    if (url.pathname === "/global/event" || url.pathname === "/event") {
      if (request.method !== "GET") return methodNotAllowed(request);
      return events.response();
    }

    if (url.pathname === "/session" && request.method === "POST") {
      return readCreateSessionRequest(request, config.cwd).then(
        async (parsed) => {
          if (parsed.kind === "error") {
            return jsonResponse(
              contractError("invalid_request", parsed.message),
              400
            );
          }
          try {
            return jsonResponse(
              sessionResponse(
                await sessions.createSession(parsed.input),
                config
              )
            );
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "Session creation failed.";
            return jsonResponse(contractError("session_exists", message), 409);
          }
        }
      );
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

    const sessionPath =
      /^\/session\/([^/]+)(\/message|\/prompt|\/prompt_async|\/abort|\/revert|\/event)?$/u.exec(
        url.pathname
      );
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
  const sessions = new SessionRegistry(new PiSessionBackend(config));
  const events = new EventHub();
  const server = Bun.serve({
    fetch: createSessionHandler(config, sessions, events),
    hostname: config.host,
    port: config.port,
  });
  console.log(`pi-opencode-server listening on ${server.url}`);
  return server;
}

if (import.meta.main) runServer();
