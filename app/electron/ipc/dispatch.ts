type Input = Record<string, unknown>;
/** A handler returns a reply value, or nothing to reply with a snapshot. */
interface Reply {
  value: unknown;
}
type Handler = (data: Input) => Promise<Reply | void> | Reply | void;
export type Commands = Record<string, Handler>;
interface Result {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export const reply = (value: unknown): Reply => ({ value });
export const text = (value: unknown, max = 500): string => {
  if (typeof value !== "string" || value.length > max)
    throw new Error("Invalid input");
  return value;
};
export const number = (value: unknown, min: number, max: number): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error("Value outside allowed range");
  return value;
};
/** Optional PIN field: absent or empty means "use the current unlock". */
export const optionalPin = (value: unknown): string | undefined =>
  value === undefined || value === "" ? undefined : text(value, 12);

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
/**
 * Copy a renderer payload into a null-prototype record of its own enumerable
 * keys. Arrays, class instances and prototype-pollution keys are dropped.
 */
const payload = (input: unknown): Input => {
  const data = Object.create(null) as Input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return data;
  const proto = Object.getPrototypeOf(input) as unknown;
  if (proto !== Object.prototype && proto !== null) return data;
  const keys = Object.keys(input);
  if (keys.length > 32) throw new Error("Invalid input");
  for (const key of keys)
    if (!FORBIDDEN.has(key)) data[key] = (input as Input)[key];
  return data;
};

/** Run one command from the renderer. Errors become messages, never throws. */
export async function dispatch(
  commands: Commands,
  command: unknown,
  input: unknown,
  snapshot: () => unknown,
  changed: () => void,
): Promise<Result> {
  try {
    const op = text(command, 40),
      data = payload(input);
    if (!Object.hasOwn(commands, op)) throw new Error("Unknown operation");
    const result = await commands[op](data);
    if (result) return { ok: true, value: result.value };
    changed();
    return { ok: true, value: snapshot() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Operation failed",
    };
  }
}
