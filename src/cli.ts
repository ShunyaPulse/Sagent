import readline from "readline";
import { exec } from "node:child_process";
import fsSync, { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentEngine } from "./core/engine.js";
import { getLLMProvider } from "./providers/index.js";
import { GeminiKeyRotator } from "./providers/key-rotator.js";
import { env, reloadEnv } from "./config/env.js";

// Suppress pg-connection-string security warning
process.on("warning", (warning) => {
  if (
    warning.name === "SecurityWarning" ||
    warning.message.includes("SSL modes")
  ) {
    return;
  }
  console.warn(warning);
});

import { pool } from "./db/postgres.js";

function formatToolCallInfo(tool: string, args: Record<string, any>): string {
  if (!args) return "";
  if (tool === "file_writer") {
    const bytes =
      typeof args.content === "string"
        ? Buffer.byteLength(args.content, "utf8")
        : 0;
    return `"${args.path || ""}", ${bytes} B`;
  }
  if (tool === "file_reader") {
    return `"${args.path || ""}"`;
  }
  if (tool === "directory_lister") {
    return `"${args.path || "."}"`;
  }
  if (tool === "sql_vector_search") {
    const q = args.query || "";
    return `"${q.length > 30 ? q.slice(0, 30) + "..." : q}"`;
  }
  if (tool === "data_calculator") {
    return `"${args.expression || ""}"`;
  }
  if (tool === "http_fetcher" || tool === "webhook_dispatcher") {
    return `"${args.url || ""}"`;
  }
  return JSON.stringify(args);
}

async function copyToClipboard(text: string): Promise<void> {
  // 1. Primary: Native OSC 52 ANSI escape sequence (works across VS Code terminal, modern terminals & SSH)
  try {
    const b64 = Buffer.from(text, "utf8").toString("base64");
    process.stdout.write(`\x1b]52;c;${b64}\x07`);
  } catch {}

  // 2. Fallback: OS native clipboard utilities (only if GUI display or supported platform is present)
  try {
    let cmd = "";
    if (process.platform === "darwin") cmd = "pbcopy";
    else if (process.platform === "win32") cmd = "clip";
    else if (process.env.WAYLAND_DISPLAY) cmd = "wl-copy";
    else if (process.env.DISPLAY) cmd = "xclip -selection clipboard || xsel -b";

    if (cmd) {
      const proc = exec(cmd, () => {});
      if (proc.stdin) {
        proc.stdin.on("error", () => {});
        proc.on("error", () => {});
        proc.stdin.write(text);
        proc.stdin.end();
      }
    }
  } catch {}

  // 3. Guaranteed Fallback file: Persist in scratch/last_response.txt
  try {
    const scratchDir = path.resolve(process.cwd(), "scratch");
    await fs.mkdir(scratchDir, { recursive: true });
    await fs.writeFile(
      path.join(scratchDir, "last_response.txt"),
      text,
      "utf8",
    );
  } catch {}
}

interface ConversationTurn {
  userMessage: string;
  assistantAnswer: string;
  timestamp: string;
  tools: any[];
}

async function createShareFile(
  sessionId: string,
  history: ConversationTurn[],
): Promise<string> {
  const scratchDir = path.resolve(process.cwd(), "scratch");
  await fs.mkdir(scratchDir, { recursive: true });
  const filename = `share_${Date.now()}.md`;
  const filePath = path.join(scratchDir, filename);

  let markdown = `# Sagentic Conversation History
- **Session ID**: \`${sessionId}\`
- **Exported At**: ${new Date().toISOString()}
- **Total Exchanges**: ${history.length}
- **Model Architecture**: Tier 1 (${env.CLOUDFLARE_LORA_NAME || "Llama 3.1 8B"}) ➔ Tier 2 (Gemini Pool)

---
`;

  history.forEach((turn, idx) => {
    markdown += `\n### Turn ${idx + 1}\n\n`;
    markdown += `**You**:\n${turn.userMessage}\n\n`;
    markdown += `**Sagentic**:\n${turn.assistantAnswer}\n\n`;
    if (turn.tools && turn.tools.length > 0) {
      markdown += `*Tools & Sources (${turn.tools.length})*:\n`;
      turn.tools.forEach((t) => {
        markdown += `- \`${t.tool}\` (${t.durationMs || 0}ms) - ${t.isError ? "Error" : "Success"}\n`;
      });
      markdown += "\n";
    }
    markdown += "---\n";
  });

  await fs.writeFile(filePath, markdown, "utf8");
  await copyToClipboard(markdown);
  return path.relative(process.cwd(), filePath);
}

function displaySources(tools: any[]): void {
  if (!tools || tools.length === 0) {
    console.log(
      "\x1b[90mℹ Direct model knowledge (no external tools or database lookups were required).\x1b[0m\n",
    );
    return;
  }

  console.log(`\x1b[1m● Executed Tools & Sources (${tools.length}):\x1b[0m`);
  tools.forEach((t, i) => {
    console.log(
      `  \x1b[36m${i + 1}.\x1b[0m \x1b[1m${t.tool}\x1b[0m \x1b[90m(${t.durationMs || 0}ms)\x1b[0m`,
    );
    if (t.args && Object.keys(t.args).length > 0) {
      console.log(`     \x1b[90mArgs: ${JSON.stringify(t.args)}\x1b[0m`);
    }
    if (t.result) {
      const preview =
        typeof t.result === "string" ? t.result : JSON.stringify(t.result);
      console.log(
        `     \x1b[90mOutput: ${preview.length > 120 ? preview.slice(0, 120) + "..." : preview}\x1b[0m`,
      );
    }
  });
  console.log("");
}

export async function runCli(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 1. Check AI Provider credentials
  const hasKey = Boolean(
    env.GEMINI_API_KEY ||
      (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN),
  );

  if (!hasKey) {
    await new Promise<void>((resolve) => {
      console.log(
        `\n\x1b[1m\x1b[36mWelcome to Sagentic!\x1b[0m\n\x1b[90mNo AI API Key found in environment.\x1b[0m`,
      );
      console.log(
        `Get a free Gemini API key at: \x1b[4mhttps://aistudio.google.com/app/apikey\x1b[0m\n`,
      );
      rl.question("\x1b[33mEnter GEMINI_API_KEY:\x1b[0m ", (inputKey) => {
        const key = (inputKey || "").trim();
        if (key) {
          process.env.GEMINI_API_KEY = key;
          try {
            const configDir = path.join(os.homedir(), ".sagentic");
            if (!fsSync.existsSync(configDir)) {
              fsSync.mkdirSync(configDir, { recursive: true });
            }
            fsSync.appendFileSync(
              path.join(configDir, ".env"),
              `GEMINI_API_KEY=${key}\n`,
              "utf8",
            );
            console.log(`\x1b[32m✔ Saved key to ~/.sagentic/.env\x1b[0m\n`);
          } catch {}
          reloadEnv();
          GeminiKeyRotator.getInstance().reloadKeys();
        } else {
          console.log(`\x1b[31m✖ No API key provided. Exiting.\x1b[0m\n`);
          process.exit(1);
        }
        resolve();
      });
    });
  }

  const loraDisplay = env.CLOUDFLARE_LORA_NAME
    ? `LoRA: ${env.CLOUDFLARE_LORA_NAME}`
    : "Base 8B";

  console.log(
    `\x1b[1mSagentic\x1b[0m \x1b[90mv1.0.2 (Tier 1: ${loraDisplay} ➔ Tier 2: Gemini Pool)\x1b[0m\n\x1b[90mType \x1b[33m/help\x1b[90m for commands or ask anything.\x1b[0m\n`,
  );

  const engine = new AgentEngine();
  const provider = getLLMProvider();
  let sessionId = `cli_${Date.now()}`;
  const tenantId = "default";
  let debugMode = false;

  const sessionHistory: ConversationTurn[] = [];
  let lastUserMessage = "";
  let lastAssistantAnswer = "";
  let lastToolExecutions: any[] = [];

  let isRunning = false;

  const shutdown = async () => {
    console.log("\n\x1b[90mBye!\x1b[0m");
    rl.close();
    try {
      if (pool) {
        await pool.end();
      }
    } catch {}
    process.exit(0);
  };

  rl.on("SIGINT", async () => {
    if (isRunning) {
      console.log("\n\x1b[33m▲ Interrupted current reasoning turn.\x1b[0m");
      isRunning = false;
      ask();
      return;
    }
    await shutdown();
  });

  const ask = () => {
    rl.question("\x1b[36m❯\x1b[0m ", async (input) => {
      const trimmed = (input || "").trim();
      if (!trimmed) {
        ask();
        return;
      }

      if (isRunning) {
        console.log(
          "\x1b[33m▲ Processing previous turn, please wait...\x1b[0m",
        );
        return;
      }

      const lower = trimmed.toLowerCase();

      // Slash Commands
      if (lower === "/copy" || lower === "/c") {
        if (!lastAssistantAnswer) {
          console.log("\x1b[33mNo response to copy yet.\x1b[0m\n");
        } else {
          await copyToClipboard(lastAssistantAnswer);
          console.log("\x1b[32m✔ Copied last response to clipboard.\x1b[0m\n");
        }
        ask();
        return;
      }

      if (lower === "/share" || lower === "/export") {
        if (sessionHistory.length === 0) {
          console.log("\x1b[33mNo conversation history to share yet.\x1b[0m\n");
        } else {
          const filePath = await createShareFile(sessionId, sessionHistory);
          console.log(
            `\x1b[35m✔ Exported full conversation (${sessionHistory.length} turns) to ${filePath} and copied to clipboard.\x1b[0m\n`,
          );
        }
        ask();
        return;
      }

      if (lower === "/sources" || lower === "/tools") {
        displaySources(lastToolExecutions);
        ask();
        return;
      }

      if (lower === "/clear" || lower === "/reset") {
        sessionId = `cli_${Date.now()}`;
        lastAssistantAnswer = "";
        lastUserMessage = "";
        lastToolExecutions = [];
        sessionHistory.length = 0;
        console.log("\x1b[32m✔ Session context cleared.\x1b[0m\n");
        ask();
        return;
      }

      if (lower === "/debug") {
        debugMode = !debugMode;
        console.log(`\x1b[33mDebug mode: ${debugMode ? "ON" : "OFF"}\x1b[0m\n`);
        ask();
        return;
      }

      if (lower === "/help") {
        console.log(`
\x1b[1mCommands:\x1b[0m
  \x1b[36m/copy, /c\x1b[0m      Copy last assistant response to clipboard
  \x1b[36m/share\x1b[0m         Export conversation to Markdown file
  \x1b[36m/sources\x1b[0m       View tools and citations used in last turn
  \x1b[36m/clear\x1b[0m         Reset conversation memory
  \x1b[36m/debug\x1b[0m         Toggle debug logs (current: ${debugMode ? "ON" : "OFF"})
  \x1b[36m/help\x1b[0m          Show this help menu
  \x1b[36mexit\x1b[0m           Quit session
`);
        ask();
        return;
      }

      if (lower === "exit" || lower === "quit" || lower === "/exit") {
        await shutdown();
        return;
      }

      isRunning = true;
      let hasStreamedFirstToken = false;
      let currentAnswer = "";
      const currentTools: any[] = [];
      let hadToolCalls = false;

      try {
        await engine.run({
          context: { sessionId, tenantId, userIp: "127.0.0.1" },
          userMessage: trimmed,
          provider,
          onEvent: (event) => {
            if (event.type === "thought") {
              if (
                event.thought &&
                event.thought !== "Direct response generated" &&
                (debugMode || process.env.DEBUG_THOUGHTS === "true")
              ) {
                console.log(`\x1b[90m● Thought: ${event.thought}\x1b[0m`);
              }
            } else if (event.type === "tool_call") {
              hadToolCalls = true;
              currentTools.push({
                tool: event.tool,
                args: event.args,
              });
              const details = formatToolCallInfo(event.tool, event.args);
              console.log(
                `\x1b[34m●\x1b[0m \x1b[1m${event.tool}\x1b[0m\x1b[90m(${details})\x1b[0m`,
              );
            } else if (event.type === "tool_result") {
              const last = currentTools[currentTools.length - 1];
              if (last && last.tool === event.tool) {
                last.result = event.result;
                last.durationMs = event.durationMs;
                last.isError = event.isError;
              }
              if (event.isError) {
                console.log(
                  `  \x1b[90m└─\x1b[0m \x1b[31m✖ Error\x1b[0m \x1b[90m(${event.durationMs}ms)\x1b[0m`,
                );
              } else {
                console.log(
                  `  \x1b[90m└─\x1b[0m \x1b[32m✔ Done\x1b[0m \x1b[90m(${event.durationMs}ms)\x1b[0m`,
                );
              }
              if (debugMode && event.result) {
                console.log(
                  `     \x1b[90m${JSON.stringify(event.result).slice(0, 120)}...\x1b[0m`,
                );
              }
            } else if (event.type === "token") {
              currentAnswer += event.text;
              if (!hasStreamedFirstToken) {
                hasStreamedFirstToken = true;
                if (hadToolCalls) {
                  process.stdout.write("\n");
                }
              }
              process.stdout.write(event.text);
            } else if (event.type === "done") {
              lastAssistantAnswer = currentAnswer;
              lastToolExecutions = [...currentTools];
              lastUserMessage = trimmed;
              sessionHistory.push({
                userMessage: trimmed,
                assistantAnswer: currentAnswer,
                timestamp: new Date().toISOString(),
                tools: [...currentTools],
              });

              console.log("\n");
              if (debugMode || process.env.DEBUG_METRICS === "true") {
                console.log(
                  `\x1b[90m[${event.latencyMs}ms | ${event.totalTokens} tokens]\x1b[0m\n`,
                );
              }
            } else if (event.type === "error") {
              console.error(`\x1b[31m✖ Error: ${event.message}\x1b[0m\n`);
            }
          },
        });
      } catch (err: any) {
        console.error(
          "\x1b[31m✖ Error running prompt:\x1b[0m",
          err.message,
          "\n",
        );
      } finally {
        isRunning = false;
      }

      if (process.stdin.isTTY || !process.stdin.readableEnded) {
        ask();
      } else {
        await shutdown();
      }
    });
  };

  rl.on("close", () => {
    if (!isRunning) {
      process.exit(0);
    }
  });

  ask();
}

// Auto-run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
