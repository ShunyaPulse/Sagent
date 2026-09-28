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

async function main() {
  console.log(`
======================================================================
🤖 Sagent Interactive Terminal CLI
🧠 Active LLM: ${env.LLM_PROVIDER.toUpperCase()} (${env.GEMINI_MODEL})
🗄️ Neon pgvector: Connected
Type your prompt below. Type 'exit' or 'quit' to end session.
======================================================================
  `);

  const engine = new AgentEngine();
  const provider = getLLMProvider();
  const sessionId = `cli_${Date.now()}`;
  const tenantId = "default";

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let isRunning = false;

  const ask = () => {
    rl.question("\n\x1b[36mYou > \x1b[0m", async (input) => {
      const trimmed = (input || "").trim();
      if (!trimmed) {
        ask();
        return;
      }
      if (
        trimmed.toLowerCase() === "exit" ||
        trimmed.toLowerCase() === "quit"
      ) {
        console.log("\n👋 Exiting Sagent CLI. Goodbye!");
        rl.close();
        process.exit(0);
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
                process.env.DEBUG_THOUGHTS === "true"
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
              if (process.env.DEBUG_TOOLS === "true") {
                console.log(
                  `\x1b[32m✔ [Result (${event.durationMs}ms)]: ${JSON.stringify(event.result).slice(0, 100)}...\x1b[0m`,
                );
              }
            } else if (event.type === "token") {
              process.stdout.write(`\x1b[37m${event.text}\x1b[0m`);
            } else if (event.type === "done") {
              console.log("\n");
              if (process.env.DEBUG_METRICS === "true") {
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
        process.exit(0);
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
