import { z } from "zod";
import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// 1. Load current working directory .env
dotenv.config({ quiet: true });

// 2. Load global user config from ~/.sagentic/.env if present
try {
  const globalEnvPath = path.join(os.homedir(), ".sagentic", ".env");
  if (fs.existsSync(globalEnvPath)) {
    dotenv.config({ path: globalEnvPath, override: false, quiet: true });
  }
} catch {}

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  // Database & Cache (Optional for standalone CLI; required for HTTP Cloud Run backend)
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),

  // Security (Required for HTTP Cloud Run backend authentication)
  AUTH_SECRET: z
    .string()
    .min(16, "AUTH_SECRET must be at least 16 characters for security")
    .optional(),
  ORIGIN_SECRET: z
    .string()
    .min(
      16,
      "ORIGIN_SECRET must be at least 16 characters for origin shielding",
    )
    .optional(),
  ENABLE_ORIGIN_SHIELDING: z
    .preprocess(
      (val) => val === true || val === "true" || val === "1",
      z.boolean(),
    )
    .default(false),

  // AI Models
  LLM_PROVIDER: z
    .enum(["gemini", "cloudflare", "model-first"])
    .default("model-first"),
  EMBEDDING_PROVIDER: z.enum(["gemini", "cloudflare"]).default("gemini"),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_PRO_MODEL: z.string().default("gemini-2.5-pro"),

  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_AI_MODEL: z.string().default("@cf/meta/llama-3.1-8b-instruct"),
  CLOUDFLARE_LORA_NAME: z.string().optional(),
  CLOUDFLARE_EMBEDDING_MODEL: z.string().default("@cf/baai/bge-base-en-v1.5"),

  // ReAct Agent Limits
  MAX_REACT_STEPS: z.coerce.number().default(8),
  STEP_TIMEOUT_MS: z.coerce.number().default(15000),

  // Rate Limiting
  RATE_LIMIT_MAX: z.coerce.number().default(60),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("❌ Invalid Environment Variables Configuration:");
    console.error(JSON.stringify(result.error.format(), null, 2));
    process.exit(1);
  }
  cachedEnv = result.data;
  return cachedEnv;
}

export function reloadEnv(): Env {
  cachedEnv = null;
  return loadEnv();
}

export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string | symbol) {
    if (!cachedEnv) {
      cachedEnv = loadEnv();
    }
    return (cachedEnv as any)[prop];
  },
});
