export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Object.prototype.toString.call(value) === "[object Object]"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}
