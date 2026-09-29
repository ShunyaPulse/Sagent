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

async function main() {
  console.log(`
======================================================================
🤖 Sagent Interactive Terminal CLI
🧠 Model Architecture: MODEL-FIRST (Tier 1: LoRA ${env.CLOUDFLARE_LORA_NAME} ➔ Tier 2: Gemini 34-Key Pool)
🗄️ Neon pgvector: Connected
Commands: /clear (reset session), /debug (toggle debug), /help, exit
======================================================================
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
    rl.question("\n\x1b[36mYou > \x1b[0m", async (input) => {
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
\x1b[36mCLI Commands:\x1b[0m
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
        console.log(`\x1b[32m🧹 Session reset! New session: ${sessionId}\x1b[0m`);
        ask();
        return;
      }

      if (lower === "/debug") {
        debugMode = !debugMode;
        console.log(`\x1b[33m🔧 Debug mode is now ${debugMode ? "ENABLED" : "DISABLED"}\x1b[0m`);
        ask();
        return;
      }

      if (lower === "/session") {
        console.log(`
\x1b[36mActive Session Details:\x1b[0m
  Session ID: ${sessionId}
  Tenant ID:  ${tenantId}
  Active LLM: ${env.LLM_PROVIDER} (LoRA: ${env.CLOUDFLARE_LORA_NAME || "None"})
        `);
        ask();
        return;
      }

      console.log("\x1b[33m⚡ Sagent is thinking...\x1b[0m");
      isRunning = true;

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
              const display =
                event.tool === "sql_vector_search"
                  ? "Searching internal knowledge base..."
                  : event.tool === "http_fetcher"
                    ? "Fetching web source..."
                    : `Running tool: ${event.tool}...`;
              console.log(`\x1b[34m🔧 ${display}\x1b[0m`);
            } else if (event.type === "tool_result") {
              if (debugMode || process.env.DEBUG_TOOLS === "true") {
                console.log(
                  `\x1b[32m✔ [Result (${event.durationMs}ms)]: ${JSON.stringify(event.result).slice(0, 100)}...\x1b[0m`,
                );
              }
            } else if (event.type === "token") {
              process.stdout.write(`\x1b[37m${event.text}\x1b[0m`);
            } else if (event.type === "done") {
              console.log("\n");
              if (debugMode || process.env.DEBUG_METRICS === "true") {
                console.log(
                  `\x1b[35m[Done in ${event.latencyMs}ms | ${event.totalTokens} tokens]\x1b[0m\n`,
                );
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
