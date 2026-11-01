/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pi supplies these modules to extensions at run time; stand in for them.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  defineTool: (tool: unknown) => tool,
}));
vi.mock("typebox", () => ({
  Type: { Unsafe: (schema: unknown) => schema },
}));

import extension, { requireToolCall } from "../../../extensions/gnhf-finish.js";
import { buildAgentOutputSchema } from "./types.js";

type Handler = (event: unknown) => any;

function load() {
  const tools: any[] = [];
  const handlers = new Map<string, Handler>();
  const setActiveTools = vi.fn();
  extension({
    registerTool: (t: unknown) => tools.push(t),
    on: (name: string, h: Handler) => handlers.set(name, h),
    setActiveTools,
  } as never);
  return { tools, handlers, setActiveTools };
}

describe("gnhf-finish Pi extension (PERS-14)", () => {
  let dir: string;
  const schema = buildAgentOutputSchema({ includeStopField: false });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gnhf-ext-test-"));
    const file = join(dir, "schema.json");
    writeFileSync(file, JSON.stringify(schema));
    process.env.GNHF_PI_OUTPUT_SCHEMA = file;
  });
  afterEach(() => {
    delete process.env.GNHF_PI_OUTPUT_SCHEMA;
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing outside gnhf (no schema file): ordinary Pi sessions are untouched", () => {
    delete process.env.GNHF_PI_OUTPUT_SCHEMA;
    const { tools, handlers } = load();
    expect(tools).toEqual([]);
    expect(handlers.size).toBe(0);
  });

  it("registers gnhf_finish with gnhf's schema as parameters and terminates on call", async () => {
    const { tools } = load();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("gnhf_finish");
    expect(tools[0].parameters).toEqual(schema);
    const args = { success: true, summary: "s" };
    const result = await tools[0].execute("id", args);
    expect(result.terminate).toBe(true);
    expect(result.details).toEqual(args);
  });

  it("forces the call at most twice when the run settles without it", () => {
    const { handlers, setActiveTools } = load();
    const settle = handlers.get("agent_before_settle")!;
    const first = settle({ outcome: "completed" });
    expect(first.continue).toBe(true);
    expect(setActiveTools).toHaveBeenCalledWith(["gnhf_finish"]);
    expect(settle({ outcome: "completed" }).continue).toBe(true);
    expect(settle({ outcome: "completed" })).toBeUndefined();
  });

  it("does not interfere with aborted or errored runs", () => {
    const { handlers } = load();
    expect(
      handlers.get("agent_before_settle")!({ outcome: "aborted" }),
    ).toBeUndefined();
  });

  it("stays quiet once gnhf_finish was called", async () => {
    const { tools, handlers, setActiveTools } = load();
    await tools[0].execute("id", {});
    expect(
      handlers.get("agent_before_settle")!({ outcome: "completed" }),
    ).toBeUndefined();
    expect(setActiveTools).not.toHaveBeenCalled();
  });

  it("requires a tool call only on requests after the hook fired", () => {
    const { handlers } = load();
    const request = handlers.get("before_provider_request")!;
    const payload = { tools: [{ type: "function" }] };
    expect(request({ payload })).toBeUndefined();
    handlers.get("agent_before_settle")!({ outcome: "completed" });
    expect(request({ payload })).toMatchObject({ tool_choice: "required" });
  });
});

describe("requireToolCall", () => {
  it("maps tool_choice per provider API", () => {
    expect(requireToolCall({ tools: [{ type: "function" }] })).toMatchObject({
      tool_choice: "required",
    });
    expect(
      requireToolCall({ tools: [{ name: "x", input_schema: {} }] }),
    ).toMatchObject({ tool_choice: { type: "any" } });
    expect(
      requireToolCall({ toolConfig: { tools: [{ toolSpec: {} }] } }),
    ).toMatchObject({ toolConfig: { toolChoice: { any: {} } } });
    expect(
      requireToolCall({ config: { tools: [{ functionDeclarations: [] }] } }),
    ).toMatchObject({
      config: { toolConfig: { functionCallingConfig: { mode: "ANY" } } },
    });
  });
});
