import { createCaptureHandler, makeCaptureConfig } from "./recorder.ts";

const target = Bun.env.CAPTURE_TARGET;
if (target === undefined || target.trim().length === 0) {
  throw new Error(
    "CAPTURE_TARGET is required, for example http://127.0.0.1:4096"
  );
}

const output = Bun.env.CAPTURE_OUTPUT ?? "artifacts/raw/capture.jsonl";
const maxBodyBytes = Number(Bun.env.CAPTURE_MAX_BODY_BYTES ?? 8 * 1024 * 1024);
const config = makeCaptureConfig(target, output, maxBodyBytes);
const { handler } = createCaptureHandler(config);
const server = Bun.serve({
  fetch: handler,
  hostname: Bun.env.CAPTURE_HOST ?? "127.0.0.1",
  port: Number(Bun.env.CAPTURE_PORT ?? 0),
});

console.log(`capture proxy listening on ${server.url}`);
console.log(`forwarding to ${config.target}`);
console.log(`writing JSONL to ${config.output}`);
