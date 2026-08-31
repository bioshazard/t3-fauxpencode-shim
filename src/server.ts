import { loadConfig } from "./config.ts";
import { contractError } from "./contract.ts";
import type {
  ErrorResponse,
  HealthResponse,
  ProviderResponse,
  ShimConfig,
} from "./types.ts";

function jsonResponse(
  body: HealthResponse | ProviderResponse | ErrorResponse,
  status = 200
): Response {
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
  config: ShimConfig
): (request: Request) => Response {
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
      return jsonResponse(
        contractError(
          "unimplemented_contract",
          "Session creation is the next POC slice."
        ),
        501
      );
    }

    if (url.pathname === "/session") return methodNotAllowed(request);

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
  const server = Bun.serve({
    fetch: createHandler(config),
    hostname: config.host,
    port: config.port,
  });
  console.log(`pi-opencode-server listening on ${server.url}`);
  return server;
}

if (import.meta.main) runServer();
