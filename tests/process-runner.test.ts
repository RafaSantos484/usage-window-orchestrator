import { describe, expect, it } from "vitest";
import { spawnProcessRunner } from "../src/adapters/process-runner.ts";

/** Uses this Node binary rather than shell built-ins. The runner targets POSIX. */
const NODE = process.execPath;

function never(): AbortSignal {
  return new AbortController().signal;
}

describe("spawnProcessRunner", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const result = await spawnProcessRunner({
      command: NODE,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
      env: {},
      signal: never(),
    });

    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.spawnErrorCode).toBeUndefined();
  });

  it("bounds captured output by UTF-8 bytes", async () => {
    const result = await spawnProcessRunner({
      command: NODE,
      args: ["-e", "process.stdout.write('é'.repeat(100000))"],
      env: {},
      signal: never(),
    });

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64 * 1024);
  });

  it("reports a missing binary instead of throwing", async () => {
    const result = await spawnProcessRunner({
      command: "/nonexistent/definitely-not-a-real-binary",
      args: [],
      env: {},
      signal: never(),
    });

    expect(result.spawnErrorCode).toBe("ENOENT");
    expect(result.exitCode).toBeNull();
  });

  it("gives the child exactly the environment it was handed", async () => {
    process.env.LEAKY_TEST_VARIABLE = "should-not-be-visible";
    try {
      const result = await spawnProcessRunner({
        command: NODE,
        args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        env: { ONLY_THIS: "yes" },
        signal: never(),
      });

      const childEnv = JSON.parse(result.stdout);
      expect(childEnv.ONLY_THIS).toBe("yes");
      expect(childEnv).not.toHaveProperty("LEAKY_TEST_VARIABLE");
    } finally {
      delete process.env.LEAKY_TEST_VARIABLE;
    }
  });

  it("never runs through a shell, so arguments cannot become commands", async () => {
    const result = await spawnProcessRunner({
      command: NODE,
      args: ["-e", "process.stdout.write(process.argv[1] ?? '')", "; echo pwned"],
      env: {},
      signal: never(),
    });

    expect(result.stdout).toBe("; echo pwned");
    expect(result.exitCode).toBe(0);
  });

  it("settles promptly on abort even when a grandchild still holds the pipes", async () => {
    // A CLI that spawns its own children hands them the same stdout/stderr.
    // Waiting for "close" would then block until the grandchild exited.
    const controller = new AbortController();
    const started = Date.now();

    const pending = spawnProcessRunner({
      command: NODE,
      args: [
        "-e",
        "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'});" +
          "setTimeout(()=>{},30000);",
      ],
      env: {},
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 150);
    const result = await pending;

    expect(result.timedOut).toBe(true);
    // Well inside the orchestrator's grace period; a "close"-only implementation
    // would have taken the full 30 seconds here.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("treats an already-aborted signal as an immediate termination", async () => {
    const result = await spawnProcessRunner({
      command: NODE,
      args: ["-e", "setTimeout(()=>{},10000)"],
      env: {},
      signal: AbortSignal.abort(),
    });

    expect(result.timedOut).toBe(true);
  });
});
