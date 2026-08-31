import { expect, test } from "@playwright/test";

const prompt = process.env.PW_SHIM_PROMPT?.trim() || "T3_PI_OK";

test.describe("pi-opencode-server HTTP contract", () => {
  test("reports T3-compatible health and Pi model discovery", async ({
    request,
  }) => {
    const health = await request.get("/global/health");
    expect(health.ok()).toBe(true);
    expect(await health.json()).toMatchObject({
      healthy: true,
      service: "pi-opencode-server",
      version: "1.14.19",
    });

    const providers = await request.get("/provider");
    expect(providers.ok()).toBe(true);
    expect(await providers.json()).toMatchObject({
      connected: ["pi"],
      default: { pi: expect.any(String) },
      all: [
        {
          id: "pi",
          name: "Pi",
          source: "custom",
        },
      ],
    });
  });

  test("keeps the global event stream open and sends its connection frame", async ({
    page,
  }) => {
    await page.goto("/global/health");

    const eventStream = await page.evaluate(async () => {
      const controller = new AbortController();
      const response = await fetch("/global/event", {
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      if (reader === undefined)
        throw new Error("global event stream has no body");
      const first = await reader.read();
      await reader.cancel();
      controller.abort();
      return {
        contentType: response.headers.get("content-type"),
        frame: new TextDecoder().decode(first.value),
        status: response.status,
      };
    });

    expect(eventStream.status).toBe(200);
    expect(eventStream.contentType).toContain("text/event-stream");
    expect(eventStream.frame).toContain(": connected");
  });

  test("preserves the caller messageID through a real HTTP prompt", async ({
    request,
  }) => {
    const sessionID = `playwright-${crypto.randomUUID()}`;
    const messageID = `message-${crypto.randomUUID()}`;
    const created = await request.post("/session", {
      data: { cwd: process.cwd(), id: sessionID, title: "Playwright contract" },
    });
    expect(created.ok()).toBe(true);

    const prompted = await request.post(`/session/${sessionID}/message`, {
      data: { messageID, text: prompt },
      timeout: 25_000,
    });
    expect(prompted.ok()).toBe(true);

    const history = await request.get(`/session/${sessionID}/message`);
    expect(history.ok()).toBe(true);
    const messages = (await history.json()) as Array<{
      readonly info?: { readonly id?: string; readonly role?: string };
    }>;
    expect(
      messages.find((message) => message.info?.role === "user")?.info?.id
    ).toBe(messageID);
  });
});
