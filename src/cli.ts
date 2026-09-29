import readline from "readline";
import { exec } from "node:child_process";
import fsSync, { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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

const DEFAULT_REMOTE_ENDPOINT =
  "https://sagentic-ohyotaaora-el.a.run.app/api/v1/agent/chat";

function formatToolCallInfo(tool: string, args: Record<string, any>): string {
  if (!args) return "";
  if (tool === "file_writer") {
    const bytes =
      typeof args.content === "string"
        ? Buffer.byteLength(args.content, "utf8")
        : 0;
    return `"${args.path || ""}", ${bytes} B`;
  }
  if (tool === "file_patcher") {
    return `"${args.path || ""}"`;
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
  mode: string,
): Promise<string> {
  const scratchDir = path.resolve(process.cwd(), "scratch");
  await fs.mkdir(scratchDir, { recursive: true });
  const filename = `share_${Date.now()}.md`;
  const filePath = path.join(scratchDir, filename);

  let markdown = `# Sagentic Conversation History
- **Session ID**: \`${sessionId}\`
- **Exported At**: ${new Date().toISOString()}
- **Total Exchanges**: ${history.length}
- **Mode**: ${mode}

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

interface StreamState {
  debugMode: boolean;
  hasStreamedFirstToken: boolean;
  hadToolCalls: boolean;
  currentAnswer: string;
  currentTools: any[];
}

function resolveLocalSafePath(targetPath: string): string | null {
  const cwd = process.cwd();
  const normalized = path.normalize(targetPath).trim();
  const absolutePath = path.isAbsolute(normalized)
    ? normalized
    : path.resolve(cwd, normalized);

  if (!absolutePath.startsWith(cwd)) {
    return null;
  }

  const base = path.basename(absolutePath);
  if (
    /^\.env/i.test(base) ||
    /^\.git/i.test(base) ||
    /\.key$/i.test(base) ||
    /\.pem$/i.test(base)
  ) {
    return null;
  }

  return absolutePath;
}

async function syncClientWorkspaceTool(
  tool: string,
  args: Record<string, any>,
): Promise<{ success: boolean; message?: string }> {
  if (!args || !args.path) return { success: false };
  const safePath = resolveLocalSafePath(args.path);
  if (!safePath) {
    return {
      success: false,
      message: `Access restricted for path: ${args.path}`,
    };
  }

  try {
    if (tool === "file_writer") {
      await fs.mkdir(path.dirname(safePath), { recursive: true });
      if (args.append) {
        await fs.appendFile(safePath, args.content || "", "utf-8");
      } else {
        await fs.writeFile(safePath, args.content || "", "utf-8");
      }
      const relPath = path.relative(process.cwd(), safePath) || args.path;
      return { success: true, message: `Saved locally to: ${relPath}` };
    }

    if (tool === "file_patcher") {
      if (!fsSync.existsSync(safePath)) {
        return {
          success: false,
          message: `Local file not found: ${args.path}`,
        };
      }
      const raw = await fs.readFile(safePath, "utf-8");
      const { targetContent, replacementContent, allowMultiple } = args;
      if (targetContent && raw.includes(targetContent)) {
        const updated = allowMultiple
          ? raw.replaceAll(targetContent, replacementContent || "")
          : raw.replace(targetContent, replacementContent || "");
        await fs.writeFile(safePath, updated, "utf-8");
        const relPath = path.relative(process.cwd(), safePath) || args.path;
        return { success: true, message: `Patched locally: ${relPath}` };
      }
      return {
        success: false,
        message: "Target content not matched in local file",
      };
    }
  } catch (err: any) {
    return { success: false, message: err.message };
  }

  return { success: false };
}

async function getLocalWorkspaceContext(userMessage: string): Promise<{
  workspaceFiles: string[];
  localFiles: Record<string, string>;
}> {
  const cwd = process.cwd();
  const workspaceFiles: string[] = [];
  const localFiles: Record<string, string> = {};

  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true });
    const ignored = new Set([
      "node_modules",
      ".git",
      "dist",
      ".next",
      ".cache",
      ".sagentic",
    ]);

    for (const entry of entries) {
      if (ignored.has(entry.name) || entry.name.startsWith(".env")) continue;
      const name = entry.isDirectory() ? `${entry.name}/` : entry.name;
      workspaceFiles.push(name);
      if (workspaceFiles.length >= 40) break;
    }

    // 1. Scan direct top-level matches
    for (const entry of entries) {
      if (entry.isFile() && !entry.name.startsWith(".env")) {
        if (userMessage.includes(entry.name)) {
          const filePath = path.join(cwd, entry.name);
          try {
            const stat = await fs.stat(filePath);
            if (stat.size < 80000) {
              const content = await fs.readFile(filePath, "utf-8");
              localFiles[entry.name] = content;
            }
          } catch {}
        }
      }
    }

    // 2. Scan arbitrary relative paths in userMessage (e.g. scratch/test.txt)
    const candidateTokens = userMessage.match(/[a-zA-Z0-9_\-\.\/\\~]+/g) || [];
    for (const token of candidateTokens) {
      if (token.includes("/") || token.includes("\\") || token.includes(".")) {
        const norm = path.normalize(token).replace(/^[\\\/]+/, "");
        const abs = path.resolve(cwd, norm);
        if (
          abs.startsWith(cwd) &&
          !norm.startsWith(".env") &&
          !norm.startsWith(".git")
        ) {
          try {
            if (fsSync.existsSync(abs) && fsSync.statSync(abs).isFile()) {
              const stat = fsSync.statSync(abs);
              if (stat.size < 80000) {
                const content = fsSync.readFileSync(abs, "utf-8");
                localFiles[norm] = content;
                localFiles[path.basename(norm)] = content;
              }
            }
          } catch {}
        }
      }
    }
  } catch {}

  return { workspaceFiles, localFiles };
}

function handleStreamEvent(event: any, state: StreamState) {
  if (event.type === "thought") {
    if (
      event.thought &&
      event.thought !== "Direct response generated" &&
      (state.debugMode || process.env.DEBUG_THOUGHTS === "true")
    ) {
      console.log(`\x1b[90m● Thought: ${event.thought}\x1b[0m`);
    }
  } else if (event.type === "tool_call") {
    state.hadToolCalls = true;
    state.currentTools.push({
      tool: event.tool,
      args: event.args,
    });
    const details = formatToolCallInfo(event.tool, event.args);
    console.log(
      `\x1b[34m●\x1b[0m \x1b[1m${event.tool}\x1b[0m\x1b[90m(${details})\x1b[0m`,
    );

    // Synchronize workspace files directly to the user's local disk
    if (event.tool === "file_writer" || event.tool === "file_patcher") {
      syncClientWorkspaceTool(event.tool, event.args).then((res) => {
        if (res.success && res.message) {
          console.log(
            `  \x1b[90m└─\x1b[0m \x1b[32m✔ Local workspace:\x1b[0m \x1b[90m${res.message}\x1b[0m`,
          );
        }
      });
    }
  } else if (event.type === "tool_result") {
    const last = state.currentTools[state.currentTools.length - 1];
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
    if (state.debugMode && event.result) {
      console.log(
        `     \x1b[90m${JSON.stringify(event.result).slice(0, 120)}...\x1b[0m`,
      );
    }
  } else if (event.type === "token") {
    state.currentAnswer += event.text;
    if (!state.hasStreamedFirstToken) {
      state.hasStreamedFirstToken = true;
      if (state.hadToolCalls) {
        process.stdout.write("\n");
      }
    }
    process.stdout.write(event.text);
  } else if (event.type === "done") {
    console.log("\n");
    if (state.debugMode || process.env.DEBUG_METRICS === "true") {
      console.log(
        `\x1b[90m[${event.latencyMs}ms | ${event.totalTokens} tokens]\x1b[0m\n`,
      );
    }
  } else if (event.type === "error") {
    console.error(`\x1b[31m✖ Error: ${event.message}\x1b[0m\n`);
  }
}

async function runRemoteStream(
  remoteUrl: string,
  sessionId: string,
  userMessage: string,
  state: StreamState,
  abortSignal: AbortSignal,
): Promise<{ latencyMs?: number; totalTokens?: number }> {
  const token =
    process.env.SAGENTIC_API_KEY ||
    process.env.AUTH_SECRET ||
    process.env.API_SECRET ||
    env.AUTH_SECRET;

  const { workspaceFiles, localFiles } =
    await getLocalWorkspaceContext(userMessage);

  const response = await fetch(remoteUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      sessionId,
      tenantId: "default",
      message: userMessage,
      stream: true,
      workspaceFiles,
      localFiles,
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    let errMsg = `HTTP ${response.status} ${response.statusText}`;
    try {
      const errJson = (await response.json()) as any;
      if (errJson && errJson.message) errMsg = errJson.message;
    } catch {}
    throw new Error(errMsg);
  }

  if (!response.body) {
    throw new Error("No response body received from server.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneEventData: any = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "done") {
            doneEventData = event;
          }
          handleStreamEvent(event, state);
        } catch {}
      }
    }
  }

  return doneEventData || {};
}

export async function runCli(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const isLocalMode =
    process.argv.includes("--local") ||
    process.env.SAGENTIC_LOCAL === "true" ||
    process.env.SAGENTIC_MODE === "local";

  const remoteEndpoint =
    process.env.SAGENTIC_API_URL || DEFAULT_REMOTE_ENDPOINT;

  let engine: any = null;
  let provider: any = null;
  let poolModule: any = null;

  if (isLocalMode) {
    // 1. Check AI Provider credentials for local execution
    const hasKey = Boolean(
      env.GEMINI_API_KEY ||
      (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN),
    );

    if (!hasKey) {
      await new Promise<void>((resolve) => {
        console.log(
          `\n\x1b[1m\x1b[36mWelcome to Sagentic (Local Mode)!\x1b[0m\n\x1b[90mNo AI API Key found in environment.\x1b[0m`,
        );
        console.log(
          `Get a free Gemini API key at: \x1b[4mhttps://aistudio.google.com/app/apikey\x1b[0m\n`,
        );
        rl.question(
          "\x1b[33mEnter GEMINI_API_KEY:\x1b[0m ",
          async (inputKey) => {
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
              const { GeminiKeyRotator } =
                await import("./providers/key-rotator.js");
              GeminiKeyRotator.getInstance().reloadKeys();
            } else {
              console.log(`\x1b[31m✖ No API key provided. Exiting.\x1b[0m\n`);
              process.exit(1);
            }
            resolve();
          },
        );
      });
    }

    const { AgentEngine } = await import("./core/engine.js");
    const { getLLMProvider } = await import("./providers/index.js");
    const { pool } = await import("./db/postgres.js");
    engine = new AgentEngine();
    provider = getLLMProvider();
    poolModule = pool;

    const loraDisplay = env.CLOUDFLARE_LORA_NAME
      ? `LoRA: ${env.CLOUDFLARE_LORA_NAME}`
      : "Base 8B";
    console.log(
      `\x1b[1mSagentic\x1b[0m \x1b[90mv1.0.8 [Local Mode] (Tier 1: ${loraDisplay} ➔ Tier 2: Gemini Pool)\x1b[0m\n\x1b[90mType \x1b[33m/help\x1b[90m for commands or ask anything.\x1b[0m\n`,
    );
  } else {
    console.log(
      `\x1b[1mSagentic\x1b[0m \x1b[90mv1.0.8 (Autonomous AI Platform ➔ Cloud Run)\x1b[0m\n\x1b[90mType \x1b[33m/help\x1b[90m for commands or ask anything.\x1b[0m\n`,
    );
  }

  let sessionId = `cli_${Date.now()}`;
  const tenantId = "default";
  let debugMode = false;

  const sessionHistory: ConversationTurn[] = [];
  let lastUserMessage = "";
  let lastAssistantAnswer = "";
  let lastToolExecutions: any[] = [];

  let isRunning = false;
  let activeAbortController: AbortController | null = null;

  const shutdown = async () => {
    console.log("\n\x1b[90mBye!\x1b[0m");
    rl.close();
    try {
      if (poolModule) {
        await poolModule.end();
      }
    } catch {}
    process.exit(0);
  };

  rl.on("SIGINT", async () => {
    if (isRunning) {
      console.log("\n\x1b[33m▲ Interrupted current reasoning turn.\x1b[0m");
      if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
      }
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
          const modeLabel = isLocalMode
            ? "Local Engine"
            : "Cloud Run Autonomous";
          const filePath = await createShareFile(
            sessionId,
            sessionHistory,
            modeLabel,
          );
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

\x1b[90mTip: Run with --local to use your own local API keys and offline engine.\x1b[0m
`);
        ask();
        return;
      }

      if (lower === "exit" || lower === "quit" || lower === "/exit") {
        await shutdown();
        return;
      }

      isRunning = true;
      const state: StreamState = {
        debugMode,
        hasStreamedFirstToken: false,
        hadToolCalls: false,
        currentAnswer: "",
        currentTools: [],
      };

      activeAbortController = new AbortController();

      try {
        if (isLocalMode) {
          await engine.run({
            context: { sessionId, tenantId, userIp: "127.0.0.1" },
            userMessage: trimmed,
            provider,
            onEvent: (event: any) => handleStreamEvent(event, state),
          });
        } else {
          await runRemoteStream(
            remoteEndpoint,
            sessionId,
            trimmed,
            state,
            activeAbortController.signal,
          );
        }

        lastAssistantAnswer = state.currentAnswer;
        lastToolExecutions = [...state.currentTools];
        lastUserMessage = trimmed;
        sessionHistory.push({
          userMessage: trimmed,
          assistantAnswer: state.currentAnswer,
          timestamp: new Date().toISOString(),
          tools: [...state.currentTools],
        });
      } catch (err: any) {
        if (activeAbortController?.signal.aborted) {
          // aborted by SIGINT
        } else {
          console.error(
            "\x1b[31m✖ Error running prompt:\x1b[0m",
            err.message,
            "\n",
          );
        }
      } finally {
        isRunning = false;
        activeAbortController = null;
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
