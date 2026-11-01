import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from "node:child_process";
import { PiAgent } from "./pi.js";
import { buildAgentOutputSchema } from "./types.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
    },
    kill: vi.fn(),
  });
  return proc as typeof proc & ReturnType<typeof spawn>;
}

function emitJson(proc: ReturnType<typeof createMockProcess>, event: unknown) {
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
}

function emitFinish(
  proc: ReturnType<typeof createMockProcess>,
  args: Record<string, unknown> = JSON.parse(finalOutput()),
) {
  emitJson(proc, {
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "gnhf_finish",
    isError: false,
    result: { content: [{ type: "text", text: "ok" }], details: args },
  });
}

function finalOutput(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    success: true,
    summary: "ok",
    key_changes_made: [],
    key_learnings: [],
    ...extra,
  });
}

describe("PiAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has the pi agent name", () => {
    expect(new PiAgent().name).toBe("pi");
  });

  it("spawns pi in JSON mode and writes the augmented prompt to stdin", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent({ extraArgs: ["--provider", "google"] });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "pi",
      [
        "--provider",
        "google",
        "-e",
        expect.stringMatching(/extensions[\\/]gnhf-finish\.ts$/),
        "--mode",
        "json",
        "--no-session",
      ],
      expect.objectContaining({
        cwd: "/work/dir",
        shell: false,
        env: expect.objectContaining({
          GNHF_PI_OUTPUT_SCHEMA: expect.any(String),
        }),
      }),
    );
    expect(proc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining("test prompt"),
    );
    expect(proc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining("gnhf_finish"),
    );
    // Intent (PERS-14): the result comes from a structured tool call, so the
    // prompt no longer asks for a JSON-only reply or embeds the schema.
    expect(proc.stdin.write).not.toHaveBeenCalledWith(
      expect.stringContaining("key_changes_made"),
    );
    expect(proc.stdin.end).toHaveBeenCalled();
  });

  it("uses a custom binary path", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent({ bin: "/custom/pi" });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "/custom/pi",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("adds the configured model before the mode flags", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent({ model: "gpt-5.5" });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "pi",
      [
        "-e",
        expect.stringMatching(/gnhf-finish\.ts$/),
        "--model",
        "gpt-5.5",
        "--mode",
        "json",
        "--no-session",
      ],
      expect.any(Object),
    );
  });

  it("uses a shell on Windows for cmd wrapper paths", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent({ bin: "C:\\tools\\pi.cmd", platform: "win32" });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\tools\\pi.cmd",
      expect.any(Array),
      expect.objectContaining({ detached: false, shell: true }),
    );
  });

  it("quotes the extension path when Windows launches pi through a shell", () => {
    // A shell splits an unquoted path with spaces, so the extension would not load.
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent({ bin: "C:\\tools\\pi.cmd", platform: "win32" });

    agent.run("test prompt", "/work/dir");

    const args = mockSpawn.mock.calls[0][1] as string[];
    const ext = args[args.indexOf("-e") + 1];
    expect(ext).toMatch(/^".*gnhf-finish\.ts"$/);
  });

  it("uses a shell on Windows when a bare override resolves to a cmd wrapper", () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    vi.mocked(execFileSync).mockReturnValue("C:\\tools\\pi.cmd\r\n" as never);
    const agent = new PiAgent({ bin: "pi-switch", platform: "win32" });

    agent.run("test prompt", "/work/dir");

    expect(mockSpawn).toHaveBeenCalledWith(
      "pi-switch",
      expect.any(Array),
      expect.objectContaining({ shell: true }),
    );
  });

  it("kills the full process tree on Windows when aborted", async () => {
    const proc = createMockProcess();
    Object.defineProperty(proc, "pid", { value: 6789 });
    mockSpawn.mockReturnValue(proc);
    const controller = new AbortController();
    const agent = new PiAgent({ platform: "win32" });

    const promise = agent.run("test prompt", "/work/dir", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow("Agent was aborted");
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "6789"],
      { stdio: "ignore" },
    );
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("passes gnhf's output schema to the extension in a temp file and deletes it afterwards", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const schema = buildAgentOutputSchema({ includeStopField: true });
    const agent = new PiAgent({ schema });

    const promise = agent.run("test prompt", "/work/dir");
    const env = mockSpawn.mock.calls[0][2]!.env as Record<string, string>;
    const schemaPath = env.GNHF_PI_OUTPUT_SCHEMA;
    expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toEqual(schema);
    // The schema reaches only this child, never the parent process env.
    expect(process.env.GNHF_PI_OUTPUT_SCHEMA).toBeUndefined();

    emitFinish(proc, JSON.parse(finalOutput({ should_fully_stop: false })));
    proc.emit("close", 0);
    await promise;

    expect(existsSync(schemaPath)).toBe(false);
  });

  it("deletes the schema file when the run fails", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const promise = new PiAgent().run("test prompt", "/work/dir");
    const schemaPath = (
      mockSpawn.mock.calls[0][2]!.env as Record<string, string>
    ).GNHF_PI_OUTPUT_SCHEMA;

    proc.emit("error", new Error("ENOENT"));
    await expect(promise).rejects.toThrow();

    expect(existsSync(schemaPath)).toBe(false);
  });

  it("reads the validated result from the gnhf_finish tool event", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const promise = new PiAgent().run("test prompt", "/work/dir");

    emitFinish(proc, JSON.parse(finalOutput({ summary: "from the tool" })));
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "from the tool" },
    });
  });

  it("ignores a Markdown final reply when gnhf_finish was called (PERS-14 failure shape)", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const promise = new PiAgent().run("test prompt", "/work/dir");

    emitFinish(proc);
    emitJson(proc, {
      type: "message_end",
      message: {
        role: "assistant",
        content: "| a | b |\n|---|---|\n| 1 | 2 |",
      },
    });
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      output: { success: true, summary: "ok" },
    });
  });

  it("fails with a clear message when pi ends without calling gnhf_finish", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const promise = new PiAgent().run("test prompt", "/work/dir");

    // A correct JSON reply in prose is no longer accepted.
    emitJson(proc, {
      type: "message_end",
      message: { role: "assistant", content: finalOutput() },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow(
      "pi ended without calling gnhf_finish",
    );
  });

  it("ignores a gnhf_finish call that pi rejected as invalid", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const promise = new PiAgent().run("test prompt", "/work/dir");

    emitJson(proc, {
      type: "tool_execution_end",
      toolName: "gnhf_finish",
      isError: true,
      result: { content: [{ type: "text", text: "Validation failed" }] },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow(
      "pi ended without calling gnhf_finish",
    );
  });

  it("requires should_fully_stop when the schema includes it", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent({
      schema: buildAgentOutputSchema({ includeStopField: true }),
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitFinish(proc);
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Invalid pi output");
  });

  it("rejects commit fields that do not match the schema enum", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent({
      schema: buildAgentOutputSchema({
        includeStopField: false,
        commitFields: [{ name: "commit_type", allowed: ["feat", "fix"] }],
      }),
    });

    const promise = agent.run("test prompt", "/work/dir");
    emitFinish(proc, JSON.parse(finalOutput({ commit_type: "chore" })));
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("Invalid pi output");
  });

  it("rejects Pi-reported assistant errors", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const promise = new PiAgent().run("test prompt", "/work/dir");

    emitJson(proc, {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "auth failed",
      },
    });
    proc.emit("close", 0);

    await expect(promise).rejects.toThrow("pi reported error: auth failed");
  });

  it("streams text deltas to onMessage and sums usage", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const onMessage = vi.fn();
    const onUsage = vi.fn();
    const promise = new PiAgent().run("test prompt", "/work/dir", {
      onMessage,
      onUsage,
    });

    emitJson(proc, {
      type: "message_update",
      message: {
        role: "assistant",
        responseId: "r1",
        usage: { input: 5, output: 3 },
      },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
      },
    });
    emitJson(proc, {
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "r2",
        usage: { input: 11, output: 7, cacheRead: 3 },
      },
    });
    emitFinish(proc);
    proc.emit("close", 0);

    await expect(promise).resolves.toMatchObject({
      usage: {
        inputTokens: 16,
        outputTokens: 10,
        cacheReadTokens: 3,
        cacheCreationTokens: 0,
      },
    });
    expect(onMessage).toHaveBeenCalledWith("hello");
  });

  it("rejects spawn errors", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.emit("error", new Error("ENOENT"));

    await expect(promise).rejects.toThrow("Failed to spawn pi: ENOENT");
  });

  it("rejects non-zero exits with stderr", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir");
    proc.stderr.emit("data", Buffer.from("bad things"));
    proc.emit("close", 2);

    await expect(promise).rejects.toThrow("pi exited with code 2: bad things");
  });

  it("surfaces a structured error emitted on stdout after a non-zero exit", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const agent = new PiAgent();

    const promise = agent.run("test prompt", "/work/dir");
    emitJson(proc, { type: "error", error: { message: "login required" } });
    proc.emit("close", 1);

    await expect(promise).rejects.toThrow(
      "pi exited with code 1: login required",
    );
  });

  // The decisions below are checked against the real pi 1.4.0 in
  // e2e/e2e-pi-finish.test.ts; these cases pin the error text.
  it.each([
    [["--tools", "read"], "--tools read"],
    [["-t", "read,bash"], "-t read,bash"],
    [["--tools", ","], "--tools ,"],
    [["--tools", "gnhf_finish", "--tools", "read"], "--tools read"],
    [["--exclude-tools", "gnhf_finish"], "--exclude-tools gnhf_finish"],
    [["-xt", "gnhf_*"], "-xt gnhf_*"],
    [["--exclude-tools", "*"], "--exclude-tools *"],
    [["--no-tools"], "--no-tools"],
    [["-nt"], "-nt"],
    [["--no-tools", "--tools", "+read"], "--no-tools"],
    [["--tools"], "--tools (no value)"],
    [["--name"], "--name (no value)"],
    [["--"], "--"],
    [["--tools", "read", "--name", "--tools", "gnhf_finish"], "--tools read"],
  ])("refuses a pi tool option that removes gnhf_finish: %j", (args, shown) => {
    expect(() => new PiAgent({ extraArgs: args })).toThrow(
      `pi option "${shown}" would make gnhf_finish unavailable`,
    );
  });

  it.each([
    ["--tools", "read,gnhf_finish"],
    ["--tools", "gnhf_*"],
    ["--tools", "+read"],
    ["--tools", "-bash"],
    ["--tools", "read", "--tools", "gnhf_finish"],
    ["--no-tools", "--tools", "gnhf_finish"],
    ["--no-tools", "--tools", "+gnhf_finish"],
    ["--tools", "--no-tools"],
    ["--exclude-tools", "read"],
    ["--exclude-tools", "gnhf_finish", "--exclude-tools", "read"],
    ["--no-builtin-tools"],
    ["--name", "--no-tools"],
    ["--system-prompt", "--tools", "x"],
  ])("accepts a pi tool option that keeps gnhf_finish: %j", (...args) => {
    expect(() => new PiAgent({ extraArgs: args })).not.toThrow();
  });
});
