import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  
  // Database & Cache
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required for Neon PostgreSQL'),
  REDIS_URL: z.string().optional(),
  
  // Security
  AUTH_SECRET: z.string().min(16, 'AUTH_SECRET must be at least 16 characters for security'),
  ORIGIN_SECRET: z.string().min(16, 'ORIGIN_SECRET must be at least 16 characters for origin shielding'),
  ENABLE_ORIGIN_SHIELDING: z.coerce.boolean().default(true),
  
  // AI Models
  LLM_PROVIDER: z.enum(['gemini', 'cloudflare']).default('gemini'),
  EMBEDDING_PROVIDER: z.enum(['gemini', 'cloudflare']).default('gemini'),
  
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_PRO_MODEL: z.string().default('gemini-2.5-pro'),
  
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_AI_MODEL: z.string().default('@cf/meta/llama-3.1-8b-instruct'),
  CLOUDFLARE_EMBEDDING_MODEL: z.string().default('@cf/baai/bge-base-en-v1.5'),
  
  // ReAct Agent Limits
  MAX_REACT_STEPS: z.coerce.number().default(8),
  STEP_TIMEOUT_MS: z.coerce.number().default(15000),
  
  // Rate Limiting
  RATE_LIMIT_MAX: z.coerce.number().default(60),
  RATE_LIMIT_WINDOW: z.string().default('1 minute')
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid Environment Variables Configuration:');
    console.error(JSON.stringify(result.error.format(), null, 2));
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
