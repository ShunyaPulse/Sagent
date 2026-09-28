import { FastifyInstance } from "fastify";
import { checkDbHealth } from "../db/postgres.js";
import { checkRedisHealth } from "../db/redis.js";

export async function healthRoutes(fastify: FastifyInstance) {
  // Liveness probe
  fastify.get("/healthz", async (_req, reply) => {
    return reply.status(200).send({
      status: "ok",
      service: "sagent",
      timestamp: new Date().toISOString(),
    });
  });

  // Readiness probe
  fastify.get("/readyz", async (_req, reply) => {
    const [dbHealthy, redisHealthy] = await Promise.all([
      checkDbHealth(),
      checkRedisHealth(),
    ]);

    const isReady = dbHealthy;

    return reply.status(isReady ? 200 : 503).send({
      status: isReady ? "ready" : "degraded",
      dependencies: {
        neonPostgres: dbHealthy ? "connected" : "unreachable",
        redis: redisHealthy ? "connected" : "fallback_mode",
      },
      timestamp: new Date().toISOString(),
    });
  });

  // Interactive Web Playground on GET / and GET /playground
  fastify.get("/", async (_req, reply) => {
    reply.type("text/html").send(PLAYGROUND_HTML);
  });

  fastify.get("/playground", async (_req, reply) => {
    reply.type("text/html").send(PLAYGROUND_HTML);
  });
}

const PLAYGROUND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sagent — Autonomous AI Agent Playground</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background-color: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .scrollbar-none::-webkit-scrollbar { display: none; }
  </style>
</head>
<body class="flex flex-col h-screen overflow-hidden">
  <!-- Header -->
  <header class="border-b border-gray-800 px-6 py-3.5 flex items-center justify-between bg-[#161b22]">
    <div class="flex items-center space-x-3">
      <div class="w-7 h-7 rounded-lg bg-gradient-to-tr from-blue-600 to-cyan-400 flex items-center justify-center text-white font-bold text-sm shadow-md">S</div>
      <h1 class="font-bold text-base text-gray-100 tracking-tight">Sagent Playground</h1>
      <span class="text-xs bg-blue-950 text-blue-400 px-2 py-0.5 rounded-full border border-blue-800 font-mono">SSE Stream</span>
    </div>
    <div class="flex items-center space-x-3 text-xs">
      <span class="flex items-center space-x-1 text-emerald-400 bg-emerald-950/60 px-2.5 py-1 rounded-full border border-emerald-800/60">
        <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
        <span>Neon & Gemini Live</span>
      </span>
    </div>
  </header>

  <!-- Main Chat Feed -->
  <main id="chatFeed" class="flex-1 overflow-y-auto p-6 space-y-4 max-w-4xl w-full mx-auto">
    <div class="bg-[#161b22] border border-gray-800 p-4 rounded-xl text-sm">
      <p class="font-semibold text-gray-200 mb-1">👋 Welcome to Sagent Playground!</p>
      <p class="text-gray-400 mb-2">Test multi-step reasoning, SSRF-protected web scraping, vector search, and safe math evaluation.</p>
      <div class="flex flex-wrap gap-2 text-xs">
        <button onclick="sendPrompt(this.innerText)" class="bg-[#21262d] hover:bg-[#30363d] text-cyan-300 px-2.5 py-1.5 rounded-lg border border-gray-700 transition">What is (450 * 1.18) - 50?</button>
        <button onclick="sendPrompt(this.innerText)" class="bg-[#21262d] hover:bg-[#30363d] text-cyan-300 px-2.5 py-1.5 rounded-lg border border-gray-700 transition">Fetch title and content of https://example.com</button>
        <button onclick="sendPrompt(this.innerText)" class="bg-[#21262d] hover:bg-[#30363d] text-cyan-300 px-2.5 py-1.5 rounded-lg border border-gray-700 transition">Search knowledge base for refund policies</button>
      </div>
    </div>
  </main>

  <!-- Input Footer -->
  <footer class="border-t border-gray-800 p-4 bg-[#161b22]">
    <form id="chatForm" onsubmit="handleSubmit(event)" class="max-w-4xl mx-auto flex gap-2">
      <input 
        id="promptInput" 
        type="text" 
        placeholder="Ask Sagent to reason, execute tools, scrape web, or calculate..." 
        autocomplete="off"
        class="flex-1 bg-[#0d1117] border border-gray-700 focus:border-blue-500 rounded-xl px-4 py-3 text-sm text-gray-100 outline-none transition"
      />
      <button 
        id="sendBtn" 
        type="submit" 
        class="bg-blue-600 hover:bg-blue-500 text-white font-medium px-5 py-3 rounded-xl text-sm transition flex items-center gap-1.5 shadow-lg shadow-blue-600/20"
      >
        <span>Send</span>
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>
      </button>
    </form>
  </footer>

  <script>
    const feed = document.getElementById('chatFeed');
    const input = document.getElementById('promptInput');
    const sendBtn = document.getElementById('sendBtn');
    let currentSessionId = 'play_' + Math.random().toString(36).substring(2, 9);

    function sendPrompt(text) {
      input.value = text;
      handleSubmit(new Event('submit'));
    }

    async function handleSubmit(e) {
      e.preventDefault();
      const message = input.value.trim();
      if (!message) return;

      input.value = '';
      input.disabled = true;
      sendBtn.disabled = true;

      // User Message Bubble
      const userBubble = document.createElement('div');
      userBubble.className = 'flex justify-end';
      userBubble.innerHTML = \`<div class="bg-blue-600 text-white px-4 py-2.5 rounded-2xl rounded-tr-none text-sm max-w-[80%]">\${escapeHtml(message)}</div>\`;
      feed.appendChild(userBubble);

      // Agent Message Container
      const agentBox = document.createElement('div');
      agentBox.className = 'bg-[#161b22] border border-gray-800 p-4 rounded-2xl text-sm space-y-2';
      agentBox.innerHTML = \`
        <div class="flex items-center space-x-2 text-xs text-gray-400 font-mono">
          <div class="w-2 h-2 rounded-full bg-blue-400 animate-ping"></div>
          <span class="status-text">Reasoning in progress...</span>
        </div>
        <div class="thought-logs space-y-1.5 text-xs text-gray-400"></div>
        <div class="answer-text text-gray-100 leading-relaxed font-sans whitespace-pre-wrap pt-1"></div>
        <div class="metrics-text text-[11px] text-gray-500 pt-2 border-t border-gray-800/80 hidden"></div>
      \`;
      feed.appendChild(agentBox);
      feed.scrollTop = feed.scrollHeight;

      const statusEl = agentBox.querySelector('.status-text');
      const thoughtsEl = agentBox.querySelector('.thought-logs');
      const answerEl = agentBox.querySelector('.answer-text');
      const metricsEl = agentBox.querySelector('.metrics-text');

      try {
        const response = await fetch('/api/v1/agent/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + (window.AUTH_KEY || 'f98a2e1d74c0b642e88a3b5c10928e45a27891234bc567de')
          },
          body: JSON.stringify({
            sessionId: currentSessionId,
            message: message,
            stream: true
          })
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.message || 'Request failed with ' + response.status);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\\n');
          buffer = lines.pop(); // Keep partial line in buffer

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.slice(6));
                handleEvent(event, statusEl, thoughtsEl, answerEl, metricsEl);
              } catch (e) {}
            }
          }
          feed.scrollTop = feed.scrollHeight;
        }
      } catch (err) {
        statusEl.textContent = 'Failed';
        statusEl.parentElement.classList.add('text-rose-400');
        answerEl.textContent = '❌ Error: ' + err.message;
      } finally {
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
        feed.scrollTop = feed.scrollHeight;
      }
    }

    function handleEvent(event, statusEl, thoughtsEl, answerEl, metricsEl) {
      if (event.type === 'thought') {
        statusEl.textContent = 'Reasoning Step ' + event.step;
        const item = document.createElement('div');
        item.className = 'p-2 bg-[#0d1117] rounded border border-gray-800 font-mono text-[11px] text-gray-400';
        item.innerHTML = '<span class="text-yellow-400 font-semibold">💭 Thought:</span> ' + escapeHtml(event.thought);
        thoughtsEl.appendChild(item);
      } else if (event.type === 'tool_call') {
        const item = document.createElement('div');
        item.className = 'p-2 bg-[#0d1117] rounded border border-blue-900/60 font-mono text-[11px] text-blue-300';
        item.innerHTML = '<span class="text-blue-400 font-semibold">🔧 Tool Call:</span> ' + escapeHtml(event.tool) + ' (' + escapeHtml(JSON.stringify(event.args)) + ')';
        thoughtsEl.appendChild(item);
      } else if (event.type === 'tool_result') {
        const item = document.createElement('div');
        item.className = 'p-2 bg-[#0d1117] rounded border border-emerald-900/60 font-mono text-[11px] text-emerald-300';
        item.innerHTML = '<span class="text-emerald-400 font-semibold">✔ Result (' + event.durationMs + 'ms):</span> ' + escapeHtml(JSON.stringify(event.result));
        thoughtsEl.appendChild(item);
      } else if (event.type === 'token') {
        answerEl.textContent += event.text;
      } else if (event.type === 'done') {
        statusEl.parentElement.classList.add('hidden');
        metricsEl.classList.remove('hidden');
        metricsEl.textContent = '⚡ Latency: ' + event.latencyMs + 'ms | Tokens: ' + event.totalTokens + ' | Thread: ' + event.sessionId;
      } else if (event.type === 'error') {
        answerEl.textContent = '❌ ' + event.message;
      }
    }

    function escapeHtml(str) {
      if (typeof str !== 'string') str = JSON.stringify(str);
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
