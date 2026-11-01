import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join as pathJoin, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findToolFilterConflict, PiAgent } from "../src/core/agents/pi.js";
import { buildAgentOutputSchema } from "../src/core/agents/types.js";

// Intent (PERS-14): when Pi's model ends in prose, the bundled stop hook must
// force a gnhf_finish call, at most twice, in the real Pi runtime. A scripted
// OpenAI-compatible server stands in for the model; Pi, the extension and gnhf
// are the real ones.

const piAvailable = (() => {
  try {
    execFileSync("pi", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const RESULT = {
  success: true,
  summary: "forced result",
  key_changes_made: [],
  key_learnings: [],
};

interface RecordedRequest {
  toolChoice: unknown;
  toolNames: string[];
}

describe.skipIf(!piAvailable || process.platform === "win32")(
  "Pi gnhf_finish stop hook against the real pi",
  () => {
    let server: Server;
    let home: string;
    let savedEnv: Record<string, string | undefined>;
    let requests: RecordedRequest[];
    let answerWithToolWhenForced: boolean;

    beforeEach(async () => {
      requests = [];
      answerWithToolWhenForced = true;
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const parsed = JSON.parse(body);
          const toolNames = (parsed.tools ?? []).map(
            (t: { function?: { name?: string } }) => t.function?.name ?? "",
          );
          requests.push({ toolChoice: parsed.tool_choice, toolNames });
          const forced = parsed.tool_choice === "required";
          const chunk = (delta: object, finish: string | null) =>
            `data: ${JSON.stringify({
              id: "c",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta, finish_reason: finish }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            })}\n\n`;
          res.writeHead(200, { "content-type": "text/event-stream" });
          if (forced && answerWithToolWhenForced) {
            res.write(
              chunk(
                {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "gnhf_finish",
                        arguments: JSON.stringify(RESULT),
                      },
                    },
                  ],
                },
                "tool_calls",
              ),
            );
          } else {
            res.write(
              chunk(
                { role: "assistant", content: "All done. | a | b |" },
                "stop",
              ),
            );
          }
          res.end("data: [DONE]\n\n");
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;

      home = mkdtempSync(join(tmpdir(), "gnhf-pi-e2e-"));
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      writeFileSync(
        join(home, ".pi", "agent", "models.json"),
        JSON.stringify({
          providers: {
            fake: {
              api: "openai-completions",
              apiKey: "x",
              baseUrl: `http://127.0.0.1:${port}/v1`,
              models: [
                {
                  id: "fake-model",
                  name: "fake-model",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 32768,
                  maxTokens: 1024,
                },
              ],
            },
          },
        }),
      );
      // Pi reads PI_CODING_AGENT_DIR before HOME, so pin both to the fixture.
      savedEnv = {
        HOME: process.env.HOME,
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
        PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK,
      };
      process.env.HOME = home;
      process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
      process.env.PI_SKIP_VERSION_CHECK = "1";
    });

    afterEach(async () => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await new Promise((r) => server.close(r));
      rmSync(home, { recursive: true, force: true });
    });

    it("forces gnhf_finish when the model ends in prose", async () => {
      const agent = new PiAgent({ extraArgs: ["--model", "fake/fake-model"] });
      const result = await agent.run("do the thing", home);

      expect(result.output).toMatchObject({ summary: "forced result" });
      expect(requests).toHaveLength(2);
      expect(requests[0].toolChoice).toBeUndefined();
      expect(requests[1].toolChoice).toBe("required");
      expect(requests[1].toolNames).toEqual(["gnhf_finish"]);
    }, 60_000);

    it("gives up after two forced turns and fails the iteration", async () => {
      answerWithToolWhenForced = false;
      const agent = new PiAgent({ extraArgs: ["--model", "fake/fake-model"] });

      await expect(agent.run("do the thing", home)).rejects.toThrow(
        "pi ended without calling gnhf_finish",
      );
      expect(requests).toHaveLength(3);
      expect(requests.slice(1).map((r) => r.toolChoice)).toEqual([
        "required",
        "required",
      ]);
    }, 60_000);

    // Intent (captain decision on PERS-14 finding 2): gnhf refuses a Pi tool
    // option exactly when it would leave gnhf_finish out. Real pi is the oracle.
    it.each([
      [[], true],
      [["--tools", "read"], false],
      [["-t", "read,bash"], false],
      [["--tools", "gnhf_finish"], true],
      [["--tools", "read,gnhf_*"], true],
      [["--tools", "+read"], true],
      [["--tools", "-bash"], true],
      [["--tools", ","], false],
      [["--tools", ""], false],
      [["--tools", "read", "--tools", "gnhf_finish"], true],
      [["--tools", "gnhf_finish", "--tools", "read"], false],
      [["--no-tools"], false],
      [["-nt"], false],
      [["--no-tools", "--tools", "gnhf_finish"], true],
      [["--no-tools", "--tools", "+gnhf_finish"], true],
      [["--no-tools", "--tools", "+read"], false],
      [["--tools", "--no-tools"], true],
      [["--no-builtin-tools"], true],
      [["--name", "--no-tools"], true],
      [["--tools", "read", "--name", "--tools", "gnhf_finish"], false],
      [["--system-prompt", "--tools", "x"], true],
      [["--append-system-prompt", "--no-tools"], true],
      [["--exclude-tools", "gnhf_finish"], false],
      [["-xt", "gnhf_*"], false],
      [["--exclude-tools", "*"], false],
      [["--exclude-tools", "read"], true],
      [["--exclude-tools", "gnhf_finish", "--exclude-tools", "read"], true],
    ] as [string[], boolean][])(
      "pi %j keeps gnhf_finish: %s",
      async (filter, kept) => {
        const schemaPath = pathJoin(home, "schema.json");
        writeFileSync(
          schemaPath,
          JSON.stringify(buildAgentOutputSchema({ includeStopField: false })),
        );
        const extension = resolve(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "extensions",
          "gnhf-finish.ts",
        );
        await new Promise<void>((done) => {
          const child = spawn(
            "pi",
            [
              ...filter,
              "-e",
              extension,
              "--model",
              "fake/fake-model",
              "--mode",
              "json",
              "--no-session",
            ],
            {
              cwd: home,
              env: { ...process.env, GNHF_PI_OUTPUT_SCHEMA: schemaPath },
              stdio: ["pipe", "ignore", "ignore"],
            },
          );
          child.stdin.end("do the thing");
          // Only the first request matters; pi may otherwise keep running.
          const started = Date.now();
          const timer = setInterval(() => {
            if (requests.length > 0 || Date.now() - started > 15_000) {
              child.kill("SIGKILL");
            }
          }, 25);
          child.on("close", () => {
            clearInterval(timer);
            done();
          });
        });

        expect(requests.length).toBeGreaterThan(0);
        const piKept = requests[0].toolNames.includes("gnhf_finish");
        expect(piKept).toBe(kept);
        expect(findToolFilterConflict(filter) === undefined).toBe(piKept);
      },
      60_000,
    );

    it("accepts a filter that keeps gnhf_finish end to end", async () => {
      const agent = new PiAgent({
        extraArgs: ["--model", "fake/fake-model", "--tools", "+read"],
      });
      const result = await agent.run("do the thing", home);
      expect(result.output).toMatchObject({ summary: "forced result" });
    }, 60_000);
  },
);
