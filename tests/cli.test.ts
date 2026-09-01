import { describe, expect, test } from "bun:test";

import { defaultT3Home, parseCliOptions } from "../src/cli.ts";

describe("CLI options", () => {
  test("enables the managed T3 worker and accepts its home", () => {
    expect(parseCliOptions(["--with-t3", "--t3-home", "/tmp/t3-home"])).toEqual(
      {
        t3Home: "/tmp/t3-home",
        withT3: true,
      }
    );
  });

  test("uses an isolated T3 home beneath the configured cwd", () => {
    expect(defaultT3Home("/tmp/project")).toBe(
      "/tmp/project/.pi-opencode-shim/t3-home"
    );
  });

  test("rejects incomplete or unknown options", () => {
    expect(() => parseCliOptions(["--t3-home", "/tmp/t3-home"])).toThrow(
      "--t3-home requires --with-t3."
    );
    expect(() => parseCliOptions(["--unknown"])).toThrow("Unknown argument");
  });
});
