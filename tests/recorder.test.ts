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
      const response = await handler(new Request("http://proxy.test/event"));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("event: message");
      await store.flush();

      const records = (await Bun.file(output).text()).trim().split("\n");
      expect(records).toHaveLength(1);
      const record = JSON.parse(records[0] ?? "{}");
      expect(record.request.path).toBe("/event");
      expect(record.response.status).toBe(200);
      expect(record.body.response).toContain("event: message");
      expect(record.connection.state).toBe("closed");
      expect(record.sse.scope).toBe("global");
      expect(record.sse.reconnect).toBe(1);
      expect(record.sse.frames[0]).toMatchObject({
        event: "message",
        parsed: { text: "ok" },
        raw: 'event: message\ndata: {"text":"ok"}\n\n',
      });
    } finally {
      upstream.stop();
      await Bun.file(output).delete();
    }
  });
});
