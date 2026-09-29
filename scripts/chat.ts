import readline from "readline";
import { AgentEngine } from "../src/core/engine.js";
import { getLLMProvider } from "../src/providers/index.js";
import { env } from "../src/config/env.js";

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

import { pool } from "../src/db/postgres.js";

function getToolIcon(tool: string): string {
  switch (tool) {
    case "file_writer":
      return "✍️ ";
    case "file_reader":
      return "📄";
    case "directory_lister":
      return "📂";
    case "sql_vector_search":
      return "🔍";
    case "data_calculator":
      return "🧮";
    case "http_fetcher":
      return "🌐";
    default:
      return "🛠️ ";
  }
}

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

async function main() {
  const loraDisplay = env.CLOUDFLARE_LORA_NAME
    ? `LoRA: ${env.CLOUDFLARE_LORA_NAME}`
    : "Base 8B";

  console.log(`
\x1b[36m┌─────────────────────────────────────────────────────────────┐
│  🤖 \x1b[1mSagent Interactive Terminal\x1b[0m\x1b[36m                             │
│  🧠 Model: Tier 1 (${loraDisplay}) ➔ Tier 2 (Gemini Pool)  │
│  Type \x1b[33m/help\x1b[36m for commands, \x1b[33m/clear\x1b[36m to reset, \x1b[33mexit\x1b[36m to quit        │
└─────────────────────────────────────────────────────────────┘\x1b[0m
  `);

  const engine = new AgentEngine();
  const provider = getLLMProvider();
  let sessionId = `cli_${Date.now()}`;
  const tenantId = "default";
  let debugMode = false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let isRunning = false;

  const shutdown = async () => {
    console.log("\n👋 Exiting Sagent CLI. Goodbye!");
    rl.close();
    try {
      await pool.end();
    } catch {}
    process.exit(0);
  };

  rl.on("SIGINT", async () => {
    if (isRunning) {
      console.log("\n⚠️ Interrupted current reasoning turn.");
      isRunning = false;
      ask();
      return;
    }
    await shutdown();
  });

  const ask = () => {
    rl.question("\n\x1b[1;36mYou\x1b[0m \x1b[90m›\x1b[0m ", async (input) => {
      const trimmed = (input || "").trim();
      if (!trimmed) {
        ask();
        return;
      }

      if (isRunning) {
        console.log("⚠️ Sagent is currently processing a turn. Please wait...");
        return;
      }

      const lower = trimmed.toLowerCase();

      // Handle CLI Commands
      if (lower === "exit" || lower === "quit" || lower === "/exit") {
        await shutdown();
        return;
      }

      if (lower === "/help") {
        console.log(`
\x1b[1;36mCLI Commands:\x1b[0m
  \x1b[33m/clear\x1b[0m    - Start a fresh conversation session (resets short-term memory)
  \x1b[33m/debug\x1b[0m    - Toggle tool execution logs & reasoning thoughts (current: ${debugMode ? "ON" : "OFF"})
  \x1b[33m/session\x1b[0m  - Display current active session ID and provider status
  \x1b[33m/help\x1b[0m     - Show this help menu
  \x1b[33mexit/quit\x1b[0m - Disconnect cleanly and exit
        `);
        ask();
        return;
      }

      if (lower === "/clear" || lower === "/reset") {
        sessionId = `cli_${Date.now()}`;
        console.log(
          `\x1b[32m🧹 Session reset! New session: ${sessionId}\x1b[0m`,
        );
        ask();
        return;
      }

      if (lower === "/debug") {
        debugMode = !debugMode;
        console.log(
          `\x1b[33m🔧 Debug mode is now ${debugMode ? "ENABLED" : "DISABLED"}\x1b[0m`,
        );
        ask();
        return;
      }

      if (lower === "/session") {
        console.log(`
\x1b[1;36mActive Session Details:\x1b[0m
  Session ID: ${sessionId}
  Tenant ID:  ${tenantId}
  Active LLM: ${env.LLM_PROVIDER} (LoRA: ${env.CLOUDFLARE_LORA_NAME || "None"})
        `);
        ask();
        return;
      }

      isRunning = true;
      let hasStreamedFirstToken = false;

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
                console.log(`\x1b[90m💭 ${event.thought}\x1b[0m`);
              }
            } else if (event.type === "tool_call") {
              const icon = getToolIcon(event.tool);
              const details = formatToolCallInfo(event.tool, event.args);
              console.log(
                `\x1b[34m↳ ${icon} ${event.tool}\x1b[0m \x1b[90m(${details})\x1b[0m...`,
              );
            } else if (event.type === "tool_result") {
              if (debugMode || process.env.DEBUG_TOOLS === "true") {
                console.log(
                  `\x1b[32m  ✔ Done (${event.durationMs}ms): ${JSON.stringify(event.result).slice(0, 100)}...\x1b[0m`,
                );
              } else {
                console.log(`\x1b[32m  ✔ Done (${event.durationMs}ms)\x1b[0m`);
              }
            } else if (event.type === "token") {
              if (!hasStreamedFirstToken) {
                hasStreamedFirstToken = true;
                process.stdout.write(
                  "\n\x1b[1;32mSagent\x1b[0m \x1b[90m›\x1b[0m ",
                );
              }
              process.stdout.write(event.text);
            } else if (event.type === "done") {
              console.log("");
              if (debugMode || process.env.DEBUG_METRICS === "true") {
                console.log(
                  `\x1b[90m[Done in ${event.latencyMs}ms | ${event.totalTokens} tokens]\x1b[0m\n`,
                );
              } else {
                console.log("");
              }
            } else if (event.type === "error") {
              console.error(`\x1b[31m❌ [Error]: ${event.message}\x1b[0m`);
            }
          },
        });
      } catch (err: any) {
        console.error("\n\x1b[31mError running prompt:\x1b[0m", err.message);
      } finally {
        isRunning = false;
      }

      if (process.stdin.isTTY) {
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

main();
