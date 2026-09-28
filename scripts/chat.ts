import readline from 'readline';
import { AgentEngine } from '../src/core/engine.js';
import { getLLMProvider } from '../src/providers/index.js';
import { env } from '../src/config/env.js';

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
  const tenantId = 'default';

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = () => {
    rl.question('\n\x1b[36mYou > \x1b[0m', async (input) => {
      const trimmed = (input || '').trim();
      if (!trimmed) {
        ask();
        return;
      }
      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        console.log('\n👋 Exiting Sagent CLI. Goodbye!');
        rl.close();
        process.exit(0);
      }

      console.log('\n\x1b[33m⚡ Sagent is reasoning...\x1b[0m');

      try {
        await engine.run({
          context: { sessionId, tenantId, userIp: '127.0.0.1' },
          userMessage: trimmed,
          provider,
          onEvent: (event) => {
            if (event.type === 'thought') {
              console.log(`\x1b[90m💭 [Thought Step ${event.step}]: ${event.thought}\x1b[0m`);
            } else if (event.type === 'tool_call') {
              console.log(`\x1b[34m🔧 [Tool Call]: ${event.tool}(${JSON.stringify(event.args)})\x1b[0m`);
            } else if (event.type === 'tool_result') {
              console.log(`\x1b[32m✔ [Tool Result (${event.durationMs}ms)]: ${JSON.stringify(event.result).slice(0, 150)}...\x1b[0m`);
            } else if (event.type === 'token') {
              process.stdout.write(`\x1b[37m${event.text}\x1b[0m`);
            } else if (event.type === 'done') {
              console.log(`\n\n\x1b[35m[Done in ${event.latencyMs}ms | ${event.totalTokens} tokens]\x1b[0m`);
            } else if (event.type === 'error') {
              console.error(`\x1b[31m❌ [Error]: ${event.message}\x1b[0m`);
            }
          }
        });
      } catch (err: any) {
        console.error('\n\x1b[31mError running prompt:\x1b[0m', err.message);
      }

      ask();
    });
  };

  rl.on('close', () => {
    process.exit(0);
  });

  ask();
}

main();
