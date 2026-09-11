import { spawn } from "node:child_process";

/** Maximum bytes captured per stream. Output beyond this is dropped, not buffered. */
const MAX_CAPTURE_BYTES = 64 * 1024;
/** How long a process gets to exit after SIGTERM before it is SIGKILLed. */
const KILL_GRACE_MS = 3_000;

export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** The complete environment for the child. Nothing else is inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly cwd?: string;
}

export interface ProcessRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly termSignal: NodeJS.Signals | null;
  /** The process was killed because the abort signal fired. */
  readonly timedOut: boolean;
  /** The process could not be started at all (e.g. ENOENT). */
  readonly spawnErrorCode?: string;
  readonly spawnErrorMessage?: string;
}

/**
 * Port for running an external command. Injected into CLI-backed adapters so
 * their command construction and output classification can be tested without
 * a real binary, a real network, or real credentials.
 */
export type ProcessRunner = (spec: ProcessSpec) => Promise<ProcessRunResult>;

/**
 * Real implementation.
 *
 * Notable properties:
 *  - never uses a shell, so prompt text cannot be interpreted as shell syntax;
 *  - passes an explicit, closed environment (least privilege);
 *  - always resolves, mapping spawn failures onto the result shape;
 *  - escalates SIGTERM to SIGKILL so an abort cannot leave a process behind;
 *  - kills the whole process group, and settles on `exit` rather than `close`
 *    when it has killed something. A CLI that spawns children of its own hands
 *    them the same stdout/stderr pipes, so those pipes - and therefore `close`
 *    - can outlive the process we killed. Waiting for `close` there would hang
 *    until the grandchild finished on its own.
 */
export const spawnProcessRunner: ProcessRunner = (spec) =>
  new Promise<ProcessRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(spec.command, [...spec.args], {
      env: { ...spec.env },
      cwd: spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      // Its own process group, so an abort can take the whole tree down.
      detached: true,
    });

    const finish = (result: ProcessRunResult) => {
      if (settled) return;
      settled = true;
      spec.signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    /** Signals the child's whole process group. */
    function terminate(signal: NodeJS.Signals) {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, signal);
        }
      } catch {
        /* group already gone, or no permission */
      }
    }

    function onAbort() {
      timedOut = true;
      terminate("SIGTERM");
      killTimer = setTimeout(() => terminate("SIGKILL"), KILL_GRACE_MS);
    }

    if (spec.signal.aborted) {
      onAbort();
    } else {
      spec.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendCapture(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendCapture(stderr, chunk);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        stdout,
        stderr,
        exitCode: null,
        termSignal: null,
        timedOut,
        spawnErrorCode: error.code ?? "UNKNOWN",
        spawnErrorMessage: error.message,
      });
    });

    // After a kill we settle here: the process we terminated is gone, even if
    // an orphaned grandchild is still holding the pipes open.
    child.on("exit", (code, termSignal) => {
      if (!timedOut) return;
      finish({
        stdout,
        stderr,
        exitCode: code,
        termSignal,
        timedOut,
      });
    });

    child.on("close", (code, termSignal) => {
      finish({
        stdout,
        stderr,
        exitCode: code,
        termSignal,
        timedOut,
      });
    });
  });

function appendCapture(current: string, chunk: string): string {
  const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  const bytes = Buffer.from(chunk, "utf8");
  if (bytes.byteLength <= remaining) return current + chunk;

  // Keep the captured prefix valid UTF-8 when a multibyte character crosses
  // the byte boundary. Node's decoder otherwise replaces the partial suffix.
  let end = remaining;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return current + bytes.subarray(0, end).toString("utf8");
}
