import { expect, test } from "bun:test";

import { createRequestLogger, type RequestLogEntry } from "../src/logging.ts";

test("logs a redacted bounded request shape after its response", async () => {
  const entries: RequestLogEntry[] = [];
  const logger = createRequestLogger((entry) => entries.push(entry));
  const request = new Request("http://shim.test/session?tag=one&tag=two", {
    body: JSON.stringify({
      apiKey: "secret",
      prompt: "private",
      title: "visible",
    }),
    headers: { "content-type": "application/json", "user-agent": "t3-test" },
    method: "POST",
  });

  logger.log(
    request,
    Promise.resolve(new Response(null, { status: 204 })),
    performance.now()
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    body: { apiKey: "[REDACTED]", prompt: "[REDACTED]", title: "visible" },
    contentType: "application/json",
    method: "POST",
    path: "/session",
    query: { tag: ["one", "two"] },
    status: 204,
    type: "http.request",
    userAgent: "t3-test",
  });
});
