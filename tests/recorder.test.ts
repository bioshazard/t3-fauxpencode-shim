import { describe, expect, test } from "bun:test";

import {
  CaptureStore,
  createCaptureHandler,
  makeCaptureConfig,
  Redactor,
} from "../tools/contract/recorder.ts";

describe("contract recorder", () => {
  test("redacts credentials while preserving equality", () => {
    const redactor = new Redactor();
    const first = redactor.redact("Authorization: Bearer sk-test-secret-value");
    const second = redactor.redact("again sk-test-secret-value");

    expect(first).toBe("Authorization: Bearer <REDACTED-1>");
    expect(second).toBe("again <REDACTED-1>");
  });

  test("proxies SSE and records the raw stream body", async () => {
    const upstream = Bun.serve({
      fetch: () =>
        new Response('event: message\ndata: {"text":"ok"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
      port: 0,
    });
    const output = `/tmp/pi-shim-capture-${crypto.randomUUID()}.jsonl`;
    const config = makeCaptureConfig(upstream.url.toString(), output);
    const store = new CaptureStore(config);
    const { handler } = createCaptureHandler(config, store);

    try {
      const response = await handler(
        new Request("http://proxy.test/event", {
          headers: { "x-contract-scenario": "C06" },
        })
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("event: message");
      await store.flush();

      const records = (await Bun.file(output).text()).trim().split("\n");
      expect(records).toHaveLength(1);
      const record = JSON.parse(records[0] ?? "{}");
      expect(record.request.path).toBe("/event");
      expect(record.correlation).toMatchObject({
        "x-contract-scenario": "C06",
      });
      expect(record.correlation).toHaveProperty("x-contract-run-id");
      expect(record.response.status).toBe(200);
      expect(record.body.response).toContain("event: message");
      expect(record.connection.state).toBe("closed");
      expect(record.sse.scope).toBe("global");
      expect(record.connection.reason).toBe("server-closed");
      expect(record.sse.reconnect).toBe(1);
      expect(record.sse.frames[0]).toMatchObject({
        comments: [],
        event: "message",
        parsed: { text: "ok" },
        raw: 'event: message\ndata: {"text":"ok"}\n\n',
      });
      expect(record.sse.frames[0].receivedAtMs).toBeGreaterThanOrEqual(0);
    } finally {
      upstream.stop();
      await Bun.file(output).delete();
    }
  });

  test("parses SSE ids, retry, comments, and reconnect order", async () => {
    const upstream = Bun.serve({
      fetch: () =>
        new Response(
          ': heartbeat\nid: event-1\nretry: 2500\nevent: message\ndata: {"ok":true}\n\n',
          { headers: { "content-type": "text/event-stream" } }
        ),
      port: 0,
    });
    const output = `/tmp/pi-shim-capture-${crypto.randomUUID()}.jsonl`;
    const config = makeCaptureConfig(upstream.url.toString(), output);
    const store = new CaptureStore(config);
    const { handler } = createCaptureHandler(config, store);
    const headers = {
      "x-contract-run-id": "run-1",
      "x-contract-scenario": "C06",
    };

    try {
      for (let index = 0; index < 2; index += 1) {
        const response = await handler(
          new Request("http://proxy.test/event", { headers })
        );
        await response.arrayBuffer();
      }
      await store.flush();
      const records = (await Bun.file(output).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.map((record) => record.sse.reconnect)).toEqual([1, 2]);
      expect(records[0].sse.frames[0]).toMatchObject({
        comments: ["heartbeat"],
        id: "event-1",
        retry: 2500,
      });
    } finally {
      upstream.stop();
      await Bun.file(output).delete();
    }
  });
});
