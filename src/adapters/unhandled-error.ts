import { redact } from "../core/logging.ts";

/** Secret-safe fallback for failures before the normal application logger exists. */
export function logUnhandledError(
  error: unknown,
  secrets: readonly (string | undefined)[],
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): void {
  const detail = error instanceof Error ? error.message : String(error);
  write(
    redact(
      JSON.stringify({ level: "error", event: "unhandled_error", detail }),
      secrets,
    ),
  );
}
