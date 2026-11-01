import { execFileSync, spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgentOutputSchema,
  parseAgentOutput,
  type Agent,
  type AgentOutput,
  type AgentOutputSchema,
  type AgentResult,
  type AgentRunOptions,
  type TokenUsage,
} from "./types.js";
import {
  parseJSONLStream,
  setupAbortHandler,
  setupChildProcessHandlers,
} from "./stream-utils.js";

interface PiAgentDeps {
  bin?: string;
  extraArgs?: string[];
  model?: string;
  platform?: NodeJS.Platform;
  schema?: AgentOutputSchema;
}

type JsonRecord = Record<string, unknown>;

function shouldUseWindowsShell(
  bin: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") {
    return false;
  }

  if (/\.(cmd|bat)$/i.test(bin)) {
    return true;
  }

  if (/[\\/]/.test(bin)) {
    return false;
  }

  try {
    const resolved = execFileSync("where", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const firstMatch = resolved
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return firstMatch ? /\.(cmd|bat)$/i.test(firstMatch) : false;
  } catch {
    return false;
  }
}

function terminatePiProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
      });
    } catch {
      // Best-effort: the process may have already exited.
    }
    return;
  }

  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall back to the direct child if it was not started as a process group.
    }
  }

  child.kill("SIGTERM");
}

const FINISH_TOOL = "gnhf_finish";

/**
 * Finds the Pi extension that ships with gnhf (`extensions/gnhf-finish.ts` at
 * the package root) by walking up from this module, which works for both the
 * bundled `dist/cli.mjs` and the TypeScript sources.
 */
function findFinishExtension(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "extensions", "gnhf-finish.ts");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("gnhf Pi extension extensions/gnhf-finish.ts not found");
}

function matchesToolPattern(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`).test(name);
}

const TOOL_LIST_FLAGS = ["--tools", "-t"];
const TOOL_EXCLUDE_FLAGS = ["--exclude-tools", "-xt"];

// How pi 1.4.0's own parser (cli/args.js) consumes the next argument as a
// value, for every option other than the tool options handled below.
const VALUE_FLAGS = new Set([
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--models",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
]);
const DASH_GUARDED_VALUE_FLAGS = new Set([
  "--mode",
  "--use-theme",
  "--tui-mode",
]);
const NO_VALUE_FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "-v",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--no-session",
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
  "--no-extensions",
  "-ne",
  "--no-mcp",
  "--no-skills",
  "-ns",
  "--no-prompt-templates",
  "-np",
  "--no-themes",
  "--no-context-files",
  "-nc",
  "--verbose",
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--offline",
]);

/** Whether pi takes `next` as the value of the non-tool option `arg`. */
function consumesNext(arg: string, next: string | undefined): boolean {
  if (next === undefined) return false;
  if (VALUE_FLAGS.has(arg)) return true;
  if (DASH_GUARDED_VALUE_FLAGS.has(arg)) return !next.startsWith("-");
  if (arg === "--list-models") {
    return !next.startsWith("-") && !next.startsWith("@");
  }
  if (arg === "--print" || arg === "-p") {
    return (
      !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))
    );
  }
  if (NO_VALUE_FLAGS.has(arg) || !arg.startsWith("--") || arg.includes("=")) {
    return false;
  }
  // An unknown long option takes a following plain word as its value.
  return !next.startsWith("-") && !next.startsWith("@");
}

function toolEntries(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const isToolModifier = (entry: string) => /^[+-]/.test(entry);

/**
 * Returns the user-supplied Pi option that leaves gnhf_finish unavailable, if
 * any: a tool option that drops it from the effective tool set, or an option
 * that swallows or cuts off gnhf's own `-e` extension argument. This follows
 * how pi 1.4.0 itself reads its options: an option consumes the next
 * argument, the last `--tools` and `--exclude-tools` win, `--tools` is either
 * an allowlist of names and patterns or only `+name`/`-name` modifiers (an
 * invalid list is ignored), modifiers edit the default tools and, beside
 * `--no-tools`, are the allowed set, `--exclude-tools` applies last, and an
 * empty allowlist allows nothing. e2e/e2e-pi-finish.test.ts checks these
 * rules against the real pi.
 */
export function findToolFilterConflict(
  args: string[] = [],
): string | undefined {
  // gnhf appends `-e <extension>` after the user's args.
  const all = [...args, "-e", "gnhf-finish.ts"];
  let noTools: string | undefined;
  let allow: { shown: string; entries: string[] } | undefined;
  let exclude: { shown: string; entries: string[] } | undefined;
  let stopper: string | undefined;
  let extensionLoaded = false;

  for (let i = 0; i < all.length; i += 1) {
    const arg = all[i];
    if (i === args.length) extensionLoaded = true;
    if (arg === "--") {
      stopper = "--";
      break;
    }
    if (arg === "--no-tools" || arg === "-nt") {
      noTools = arg;
      continue;
    }
    const isAllow = TOOL_LIST_FLAGS.includes(arg);
    if (!isAllow && !TOOL_EXCLUDE_FLAGS.includes(arg)) {
      if (consumesNext(arg, all[i + 1])) {
        i += 1;
        if (i === args.length) {
          extensionLoaded = false;
          stopper = `${arg} (no value)`;
        }
      }
      continue;
    }
    if (i + 1 >= all.length) continue;
    i += 1;
    if (i === args.length) {
      extensionLoaded = false;
      stopper = `${arg} (no value)`;
    }
    const entries = toolEntries(all[i]);
    const shown = `${arg} ${all[i]}`;
    if (!isAllow) {
      exclude = { shown, entries };
      continue;
    }
    const modifiers = entries.filter(isToolModifier);
    const invalid =
      modifiers.length > 0 &&
      (modifiers.length < entries.length ||
        modifiers.some((entry) => entry.includes("*")));
    if (!invalid) allow = { shown, entries };
  }
  if (!extensionLoaded) return stopper;

  const isFinish = (entry: string) => matchesToolPattern(entry, FINISH_TOOL);
  let culprit = noTools;
  let kept = !noTools;
  if (allow) {
    if (allow.entries.some(isToolModifier)) {
      // Modifiers edit the default tools; only `--no-tools` makes them the
      // whole allowed set.
      if (noTools) {
        const selected = new Set<string>();
        for (const entry of allow.entries) {
          if (entry.startsWith("+")) selected.add(entry.slice(1));
          else selected.delete(entry.slice(1));
        }
        kept = selected.has(FINISH_TOOL);
      }
    } else {
      culprit = allow.shown;
      kept = allow.entries.some(isFinish);
    }
  }
  if (!kept) return culprit;
  if (exclude?.entries.some(isFinish)) return exclude.shown;
  return undefined;
}

function buildPiPrompt(prompt: string): string {
  return `${prompt}

## gnhf final output

When the iteration is complete, report its result by calling the ${FINISH_TOOL} tool.`;
}

function buildPiArgs(
  extensionPath: string,
  extraArgs?: string[],
  model?: string,
): string[] {
  return [
    ...(extraArgs ?? []),
    "-e",
    extensionPath,
    ...(model ? ["--model", model] : []),
    "--mode",
    "json",
    "--no-session",
  ];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord, names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function numberField(record: JsonRecord, names: string[]): number | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

function toTokenUsage(usage: JsonRecord | undefined): TokenUsage | null {
  if (!usage) return null;

  return {
    inputTokens: numberField(usage, ["input"]) ?? 0,
    outputTokens: numberField(usage, ["output"]) ?? 0,
    cacheReadTokens: numberField(usage, ["cacheRead"]) ?? 0,
    cacheCreationTokens: numberField(usage, ["cacheWrite"]) ?? 0,
  };
}

function isSameUsage(a: TokenUsage, b: TokenUsage): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens
  );
}

function messageKey(message: JsonRecord): string | null {
  const responseId = stringField(message, ["responseId", "id"]);
  if (responseId) return responseId;

  const timestamp = message.timestamp;
  if (typeof timestamp === "string" || typeof timestamp === "number") {
    return `timestamp:${timestamp}`;
  }

  return null;
}

function roleOf(message: unknown): string | undefined {
  return isRecord(message) && typeof message.role === "string"
    ? message.role
    : undefined;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class PiAgent implements Agent {
  name = "pi";

  private bin: string;
  private extraArgs?: string[];
  private model?: string;
  private platform: NodeJS.Platform;
  private schema: AgentOutputSchema;

  constructor(deps: PiAgentDeps = {}) {
    this.bin = deps.bin ?? "pi";
    this.extraArgs = deps.extraArgs;
    const conflict = findToolFilterConflict(deps.extraArgs);
    if (conflict) {
      throw new Error(
        `pi option "${conflict}" would make ${FINISH_TOOL} unavailable, which gnhf needs to read the iteration result. Allow ${FINISH_TOOL} in the option or remove it from the pi agent args.`,
      );
    }
    this.model = deps.model;
    this.platform = deps.platform ?? process.platform;
    this.schema =
      deps.schema ?? buildAgentOutputSchema({ includeStopField: false });
  }

  run(
    prompt: string,
    cwd: string,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    const { onUsage, onMessage, signal, logPath } = options ?? {};

    const useShell = shouldUseWindowsShell(this.bin, this.platform);
    // A shell joins argv with spaces, so a package path with spaces must be
    // quoted; Windows paths cannot contain double quotes.
    const extensionPath = useShell
      ? `"${findFinishExtension()}"`
      : findFinishExtension();
    const schemaDir = mkdtempSync(join(tmpdir(), "gnhf-pi-"));
    const schemaPath = join(schemaDir, "output-schema.json");
    writeFileSync(schemaPath, JSON.stringify(this.schema));

    return new Promise<AgentResult>((resolve, reject) => {
      const logStream = logPath ? createWriteStream(logPath) : null;
      const child = spawn(
        this.bin,
        buildPiArgs(extensionPath, this.extraArgs, this.model),
        {
          cwd,
          detached: this.platform !== "win32",
          shell: useShell,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, GNHF_PI_OUTPUT_SCHEMA: schemaPath },
        },
      );

      child.stdin?.write(buildPiPrompt(prompt));
      child.stdin?.end();

      if (
        setupAbortHandler(signal, child, reject, () =>
          terminatePiProcess(child, this.platform),
        )
      ) {
        return;
      }

      let latestAssistantMessage: JsonRecord | null = null;
      let finishArgs: unknown;
      let finished = false;
      const streamTextByIndex = new Map<number, string>();
      const usageByMessageKey = new Map<string, TokenUsage>();
      let lastEmittedUsage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      let anonymousKeySeq = 0;
      let currentStreamingMessageKey: string | null = null;

      const updateUsage = (message: JsonRecord, streaming = false) => {
        const usage = isRecord(message.usage)
          ? toTokenUsage(message.usage)
          : null;
        if (!usage) return;

        let key = messageKey(message);
        if (key === null) {
          if (streaming && currentStreamingMessageKey !== null) {
            key = currentStreamingMessageKey;
          } else {
            key = `assistant-anonymous-${anonymousKeySeq++}`;
            if (streaming) currentStreamingMessageKey = key;
          }
        }
        usageByMessageKey.set(key, usage);

        const cumulative: TokenUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
        for (const entry of usageByMessageKey.values()) {
          cumulative.inputTokens += entry.inputTokens;
          cumulative.outputTokens += entry.outputTokens;
          cumulative.cacheReadTokens += entry.cacheReadTokens;
          cumulative.cacheCreationTokens += entry.cacheCreationTokens;
        }

        if (!isSameUsage(cumulative, lastEmittedUsage)) {
          lastEmittedUsage = cumulative;
          onUsage?.({ ...cumulative });
        }
      };

      const rememberAssistantMessage = (
        message: unknown,
        streaming = false,
      ) => {
        if (!isRecord(message) || roleOf(message) !== "assistant") return;
        latestAssistantMessage = message;
        updateUsage(message, streaming);
      };

      parseJSONLStream<JsonRecord>(child.stdout!, logStream, (event) => {
        if (!isRecord(event)) return;

        if (
          event.type === "tool_execution_end" &&
          event.toolName === FINISH_TOOL &&
          event.isError !== true &&
          isRecord(event.result) &&
          "details" in event.result
        ) {
          finishArgs = event.result.details;
          finished = true;
        }

        if (event.type === "message_update") {
          rememberAssistantMessage(event.message, true);

          if (isRecord(event.assistantMessageEvent)) {
            const assistantEvent = event.assistantMessageEvent;
            const contentIndex =
              numberField(assistantEvent, ["contentIndex", "content_index"]) ??
              0;

            if (assistantEvent.type === "text_delta") {
              const delta = stringField(assistantEvent, [
                "delta",
                "text",
                "content",
              ]);
              if (delta) {
                const next =
                  (streamTextByIndex.get(contentIndex) ?? "") + delta;
                streamTextByIndex.set(contentIndex, next);
                const visible = next.trim();
                if (visible) onMessage?.(visible);
              }
            }

            if (assistantEvent.type === "text_end") {
              const text =
                stringField(assistantEvent, ["text", "content"]) ??
                streamTextByIndex.get(contentIndex) ??
                "";
              const visible = text.trim();
              if (visible) onMessage?.(visible);
            }
          }
        }

        if (event.type === "message_end" || event.type === "turn_end") {
          rememberAssistantMessage(event.message, true);
          currentStreamingMessageKey = null;
        }

        if (
          event.type === "agent_end" &&
          Array.isArray(event.messages) &&
          !latestAssistantMessage
        ) {
          for (let i = event.messages.length - 1; i >= 0; i -= 1) {
            const message = event.messages[i];
            if (roleOf(message) === "assistant") {
              rememberAssistantMessage(message);
              break;
            }
          }
        }
      });

      setupChildProcessHandlers(child, "pi", logStream, reject, () => {
        if (latestAssistantMessage) {
          const stopReason = latestAssistantMessage.stopReason;
          if (stopReason === "error" || stopReason === "aborted") {
            const errorMessage =
              stringField(latestAssistantMessage, [
                "errorMessage",
                "error",
                "message",
              ]) ?? compactJson(latestAssistantMessage);
            reject(new Error(`pi reported error: ${errorMessage}`));
            return;
          }
        }

        if (!finished) {
          reject(new Error(`pi ended without calling ${FINISH_TOOL}`));
          return;
        }

        let output: AgentOutput;
        try {
          output = parseAgentOutput(
            JSON.stringify(finishArgs),
            this.schema,
            "pi",
          );
        } catch (err) {
          reject(
            new Error(
              `Invalid pi output: ${err instanceof Error ? err.message : err}`,
            ),
          );
          return;
        }

        resolve({ output, usage: lastEmittedUsage });
      });
    }).finally(() => rmSync(schemaDir, { recursive: true, force: true }));
  }
}
