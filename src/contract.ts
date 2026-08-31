import type { ErrorResponse } from "./types.ts";

export function contractError(code: string, message: string): ErrorResponse {
  return { error: { code, message } };
}
