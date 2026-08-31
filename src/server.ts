import { loadConfig } from "./config.ts";
import { contractError } from "./contract.ts";
import { readCreateSessionRequest } from "./request.ts";
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

export function createHandler(
  config: ShimConfig,
  sessions = new SessionRegistry(new InMemorySessionBackend())
): (request: Request) => Response | Promise<Response> {
  return createSessionHandler(config, sessions);
}

function notFound(): Response {
  return jsonResponse(
    contractError("unknown_session", "The requested session does not exist."),
    404
  );
}

function createSessionHandler(
  config: ShimConfig,
  sessions: SessionRegistry
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
      const provider = {
        id: config.providerId,
        models: [{ id: config.modelId, name: config.modelId }],
        name: "Pi",
      };
      return jsonResponse({ default: provider.id, providers: [provider] });
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
              await sessions.createSession(parsed.input),
              201
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
      return sessions.listSessions().then((items) => jsonResponse(items));
    }

    if (url.pathname === "/session") return methodNotAllowed(request);

    const sessionPath = /^\/session\/([^/]+)(\/message)?$/u.exec(url.pathname);
    if (sessionPath !== null) {
      const sessionId = decodeURIComponent(sessionPath[1] ?? "");
      if (request.method !== "GET") return methodNotAllowed(request);
      return sessions.getSnapshot(sessionId).then((snapshot) => {
        if (snapshot === null) return notFound();
        return jsonResponse(
          sessionPath[2] === "/message" ? snapshot.messages : snapshot
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
  const server = Bun.serve({
    fetch: createSessionHandler(config, sessions),
    hostname: config.host,
    port: config.port,
  });
  console.log(`pi-opencode-server listening on ${server.url}`);
  return server;
}

if (import.meta.main) runServer();
