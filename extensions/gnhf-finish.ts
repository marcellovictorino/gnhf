/**
 * Pi extension shipped with gnhf. gnhf passes it with `-e` on the Pi command
 * it runs for an iteration, and nowhere else, so ordinary Pi sessions never
 * load it. It does nothing unless GNHF_PI_OUTPUT_SCHEMA names gnhf's schema file.
 *
 * The iteration ends by calling `gnhf_finish`, whose parameters are gnhf's
 * output schema (Pi validates the arguments). If the run is about to stop
 * without that call, the stop hook narrows the tools to `gnhf_finish` and
 * requires a tool call on the next model request, at most twice.
 */
import { readFileSync } from "node:fs";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_FORCED_TURNS = 2;

/** Adds "the model must call a tool" to a provider request payload, per API. */
export function requireToolCall(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const p = payload as Record<string, any>;

  // Google Generative AI / Gemini
  if (p.config?.tools || p.toolConfig?.functionCallingConfig) {
    if (p.config) {
      return {
        ...p,
        config: {
          ...p.config,
          toolConfig: {
            ...p.config.toolConfig,
            functionCallingConfig: { mode: "ANY" },
          },
        },
      };
    }
    return {
      ...p,
      toolConfig: {
        ...p.toolConfig,
        functionCallingConfig: { mode: "ANY" },
      },
    };
  }
  // Bedrock Converse
  if (p.toolConfig?.tools) {
    return { ...p, toolConfig: { ...p.toolConfig, toolChoice: { any: {} } } };
  }
  // Anthropic Messages
  if (
    Array.isArray(p.tools) &&
    p.tools.some((t: any) => t && typeof t === "object" && "input_schema" in t)
  ) {
    return { ...p, tool_choice: { type: "any" } };
  }
  // OpenAI Chat Completions, OpenAI Responses and compatible servers
  return { ...p, tool_choice: "required" };
}

export default function (pi: ExtensionAPI) {
  const schemaPath = process.env.GNHF_PI_OUTPUT_SCHEMA;
  if (!schemaPath) return;
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

  let finished = false;
  let forcing = false;
  let forcedTurns = 0;

  pi.registerTool(
    defineTool({
      name: "gnhf_finish",
      label: "gnhf finish",
      description:
        "Report the result of this gnhf iteration. Call this once, as the last action, after all work and checks are done.",
      parameters: Type.Unsafe(schema),
      async execute(_id: string, params: unknown) {
        finished = true;
        return {
          content: [
            { type: "text", text: "Result recorded. The iteration is over." },
          ],
          details: params,
          terminate: true,
        };
      },
    }),
  );

  pi.on("before_provider_request", (event) => {
    if (!forcing) return;
    return requireToolCall(event.payload);
  });

  pi.on("agent_before_settle", (event) => {
    if (finished || event.outcome !== "completed") return;
    if (forcedTurns >= MAX_FORCED_TURNS) return;
    forcedTurns += 1;
    forcing = true;
    pi.setActiveTools(["gnhf_finish"]);
    return {
      entries: [
        {
          type: "custom_message",
          customType: "gnhf-finish",
          content: "The iteration is over. Report its result with gnhf_finish.",
          display: true,
        },
      ],
      continue: true,
    };
  });
}
