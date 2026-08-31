import { describe, expect, test } from "bun:test";

import { loadMatrix } from "../tools/contract/matrix.ts";

describe("contract matrix", () => {
  test("starts explicitly pending until a reference corpus exists", async () => {
    const matrix = await loadMatrix();
    expect(matrix.status).toBe("pending-reference-capture");
    expect(matrix.rows).toHaveLength(0);
  });
});
