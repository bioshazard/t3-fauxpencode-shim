import { describe, expect, test } from "bun:test";

import { runScenarios } from "../tools/contract/scenarios.ts";

describe("headless contract scenarios", () => {
  test("drives the health, discovery, session, history, and text-turn flow", async () => {
    let eventController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
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
          return Response.json({ id: "capture-session" }, { status: 201 });
        }
        if (url.pathname === "/session/capture-session") {
          return Response.json({ id: "capture-session", messages: [] });
        }
        if (url.pathname === "/session/capture-session/message")
          return Response.json([]);
        if (url.pathname === "/event") {
          const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
              eventController = controller;
              controller.enqueue(encoder.encode(": connected\n\n"));
            },
            cancel: () => {
              eventController = undefined;
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        if (url.pathname === "/session/capture-session/prompt_async") {
          eventController?.enqueue(
            encoder.encode(
              'event: turn.completed\ndata: {"type":"turn.completed"}\n\n'
            )
          );
          return new Response(null, { status: 204 });
        }
        return new Response("missing", { status: 404 });
      },
      port: 0,
    });

    try {
      const report = await runScenarios(
        server.url.toString(),
        "test-corpus",
        500
      );
      expect(report.status).toBe("completed");
      expect(report.scenarios.map((scenario) => scenario.id)).toEqual([
        "C01",
        "C02",
        "C03",
        "C04",
        "C06",
      ]);
      expect(report.scenarios.at(-1)?.observedEventTypes).toEqual([
        "turn.completed",
      ]);
    } finally {
      server.stop();
    }
  });
});
