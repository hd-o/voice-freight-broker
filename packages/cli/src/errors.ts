export class CommandError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly exitCode: number;

  constructor(code: string, message: string, hint: string, exitCode = 1) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

export function serializeJson(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, item: unknown): unknown => {
      if (typeof item === "bigint") {
        return item >= Number.MIN_SAFE_INTEGER && item <= Number.MAX_SAFE_INTEGER ? Number(item) : item.toString();
      }

      if (item instanceof Uint8Array) {
        return Buffer.from(item).toString("hex");
      }

      return item;
    },
    space,
  );
}
