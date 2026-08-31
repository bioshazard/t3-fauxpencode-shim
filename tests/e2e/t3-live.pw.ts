import { expect, test } from "@playwright/test";

const pairingURL = process.env.T3_PAIR_URL?.trim();
const storageState = process.env.T3_STORAGE_STATE?.trim();
const expectedReply = process.env.T3_EXPECTED_REPLY?.trim() || "T3_PI_OK";
const prompt = process.env.T3_PROMPT?.trim() || expectedReply;

test("T3 sends a prompt through the configured external OpenCode shim", async ({
  page,
}) => {
  test.skip(
    pairingURL === undefined && storageState === undefined,
    "Set T3_PAIR_URL or T3_STORAGE_STATE to opt into the live T3 check."
  );

  if (pairingURL !== undefined) {
    await page.goto(pairingURL, { waitUntil: "domcontentloaded" });
    const token = new URL(pairingURL).hash.replace(/^#token=/u, "");
    const tokenField = page.getByRole("textbox", { name: "Pairing token" });
    if (await tokenField.isVisible()) {
      await tokenField.fill(token);
      await page.getByRole("button", { name: "Continue" }).click();
    }
    await expect(page).not.toHaveURL(/#token=/u);
  }

  await page.goto("/settings/providers", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("OpenCode", { exact: true })).toBeVisible();

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const modelButton = page
    .getByRole("button", { name: /Claude|configured/ })
    .first();
  await expect(modelButton).toBeVisible();
  await modelButton.click();
  await page.getByRole("button", { name: "OpenCode", exact: true }).click();
  await page.getByRole("option", { name: /configured OpenCode/ }).click();
  const editor = page.getByTestId("composer-editor");
  await expect(editor).toBeVisible();
  await editor.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(
    page.getByText(expectedReply, { exact: true }).last()
  ).toBeVisible();
});
