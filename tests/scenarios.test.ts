import { describe, expect, test } from "bun:test";

import { runScenarios } from "../tools/contract/scenarios.ts";

describe("headless contract scenarios", () => {
  test("drives the health, discovery, session, history, and text-turn flow", async () => {
    const eventControllers = new Map<
      string,
      { readonly enqueue: (chunk: Uint8Array) => void }
    >();
    const sessions = new Set<string>();
    const prompted = new Set<string>();
    let sessionCount = 0;
    const encoder = new TextEncoder();
    const server = Bun.serve({
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/global/health")
          return Response.json({ healthy: true });
        if (
          url.pathname === "/provider" ||
          url.pathname === "/agent" ||
          url.pathname === "/skill"
        ) {
          return Response.json([]);
        }
        if (url.pathname === "/session" && request.method === "POST") {
          if ((await request.text()) === "not-json")
            return Response.json({ error: "invalid" }, { status: 400 });
          sessionCount += 1;
          const id =
            sessionCount === 1 ? "capture-session" : `capture-${sessionCount}`;
          sessions.add(id);
          return Response.json({ id }, { status: 201 });
        }
        if (url.pathname === "/session" && request.method === "GET") {
          return Response.json([...sessions].map((id) => ({ id })));
        }
        const sessionMatch = /^\/session\/([^/]+)(?:\/(.*))?$/u.exec(
          url.pathname
        );
        if (sessionMatch !== null) {
          const id = sessionMatch[1] ?? "";
          const operation = sessionMatch[2] ?? "";
          if (!sessions.has(id))
            return new Response("missing", { status: 404 });
          if (operation === "" && request.method === "GET")
            return Response.json({ id, messages: [] });
          if (operation === "message" && request.method === "GET") {
            return Response.json(
              prompted.has(id)
                ? [
                    {
                      info: { id: "assistant-1", role: "assistant" },
                      parts: [],
                    },
                  ]
                : []
            );
          }
          if (operation === "event" && request.method === "GET") {
            const stream = new ReadableStream<Uint8Array>({
              start: (controller) => {
                eventControllers.set(id, controller);
                controller.enqueue(encoder.encode(": connected\n\n"));
              },
              cancel: () => {
                eventControllers.delete(id);
              },
            });
            return new Response(stream, {
              headers: { "content-type": "text/event-stream" },
            });
          }
          if (operation === "prompt_async" && request.method === "POST") {
            prompted.add(id);
            const body = await request.text();
            const event = body.includes("abort me")
              ? `event: session.status\ndata: ${JSON.stringify({ properties: { sessionStatus: "aborted" }, sessionID: id, type: "session.status" })}\n\n`
              : `event: turn.completed\ndata: ${JSON.stringify({ sessionID: id, type: "turn.completed" })}\n\n`;
            eventControllers.get(id)?.enqueue(encoder.encode(event));
            return new Response(null, { status: 204 });
          }
          if (operation === "abort" && request.method === "POST")
            return Response.json(true);
          if (operation === "revert" && request.method === "POST")
            return Response.json({ id });
        }
        if (url.pathname === "/event") {
          const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(encoder.encode(": connected\n\n"));
            },
            cancel: () => undefined,
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("missing", { status: 404 });
      },
      port: 0,
    });

    try {
      const report = await runScenarios(
        server.url.toString(),
        "test-corpus",
        500,
        { barrier: { waitFor: async () => true }, runId: "test-run" }
      );
      expect(report.status).toBe("completed");
      expect(report.scenarios.map((scenario) => scenario.id)).toEqual([
        "C01",
        "C02",
        "C03",
        "C04",
        "C06",
        "C05",
        "C13",
        "C14",
        "C11",
        "C18",
        "C17",
        "C07",
        "C08",
        "C09",
        "C10",
        "C12",
        "C15",
        "C16",
        "C19",
      ]);
      expect(
        report.scenarios
          .filter((scenario) => scenario.applicability === "not-applicable")
          .map((scenario) => scenario.id)
      ).toEqual(["C07", "C08", "C09", "C10", "C12", "C15", "C16", "C19"]);
      expect(
        report.scenarios.find((scenario) => scenario.id === "C06")
          ?.observedEventTypes
      ).toEqual(["turn.completed"]);
    } finally {
      server.stop();
    }
  });
});
