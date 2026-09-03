import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ProcessRunError, SpawnProcessRunner } from "../src/process-runner";

const invocation = (args: readonly string[]) => ({
  command: process.execPath,
  args,
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "/usr/bin" },
  shell: false as const,
  timeoutMs: 5_000,
  maxOutputBytes: 10_000,
});

describe("SpawnProcessRunner", () => {
  it("preserves metacharacters as one argv value without invoking a shell", async () => {
    const runner = new SpawnProcessRunner();
    const metacharacters = "$(echo injected); `echo unsafe` && echo nope";

    await expect(runner.run(invocation([
      "-e",
      "process.stdout.write(process.argv[1])",
      metacharacters,
    ]))).resolves.toMatchObject({ exitCode: 0, stdout: metacharacters, stderr: "" });
  });

  it("bounds runtime and strips protected argv from spawn failures", async () => {
    const runner = new SpawnProcessRunner();
    await expect(runner.run({
      ...invocation(["-e", "setInterval(() => {}, 1000)"]),
      timeoutMs: 50,
    })).rejects.toMatchObject({ code: "PROCESS_TIMEOUT", processStarted: true });

    const secret = "claim-ticket-never-in-spawn-error-012345";
    const error = await runner.run({
      ...invocation([secret]),
      command: "/definitely/not/a/codex/binary",
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProcessRunError);
    expect(inspect(error, { depth: 8 })).not.toContain(secret);
  });
});
