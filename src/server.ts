import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { env } from "./config/env.js";
import { pool } from "./db/postgres.js";
import { redisClient } from "./db/redis.js";
import { healthRoutes } from "./routes/health.js";
import { agentRoutes } from "./routes/agent.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { sessionRoutes } from "./routes/sessions.js";

export async function buildServer() {
  const server = Fastify({
    logger:
      env.NODE_ENV === "development" ? { level: "info" } : { level: "warn" },
    bodyLimit: 2 * 1024 * 1024,
    connectionTimeout: 60000,
    keepAliveTimeout: 5000,
  });

  await server.register(helmet, {
    contentSecurityPolicy: true,
    crossOriginEmbedderPolicy: false,
  });

  await server.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-origin-secret",
      "x-turnstile-token",
    ],
  });

  await server.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    redis:
      redisClient && redisClient.status === "ready" ? redisClient : undefined,
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return auth ? auth.slice(0, 30) : req.ip;
    },
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Rate limit of ${context.max} requests per ${context.after} exceeded.`,
    }),
  });

  await server.register(healthRoutes);
  await server.register(agentRoutes);
  await server.register(knowledgeRoutes);
  await server.register(sessionRoutes);

  return server;
}

async function start() {
  const server = await buildServer();

  try {
    await server.listen({ port: env.PORT, host: env.HOST });
    console.log(`
================================================================
🚀 Sagentic Autonomous AI Agent Platform Initialized Successfully!
📡 Listening on: http://${env.HOST}:${env.PORT}
🔒 Ingress Security: ${env.ENABLE_ORIGIN_SHIELDING ? "ORIGIN SHIELD ACTIVE" : "OPEN INGRESS"}
🧠 Default LLM Provider: ${env.LLM_PROVIDER.toUpperCase()}
🗄️ Neon pgvector: CONNECTED
⚡ Environment: ${env.NODE_ENV}
================================================================
    `);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
    try {
      await server.close();
      await pool.end();
      if (redisClient && redisClient.status === "ready") {
        await redisClient.quit();
      }
      console.log("✅ Clean shutdown completed. Exiting.");
      process.exit(0);
    } catch (err) {
      console.error("❌ Error during graceful shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start();
