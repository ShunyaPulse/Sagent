import { LLMProvider, EmbeddingProvider } from '../core/types.js';
import { GeminiProvider } from './gemini.js';
import { CloudflareWorkersAIProvider } from './cloudflare.js';
import { ModelFirstProvider } from './model-first.js';
import { GeminiEmbeddingProvider } from './embedding-gemini.js';
import { CloudflareEmbeddingProvider } from './embedding-cloudflare.js';
import { env } from '../config/env.js';

export function getLLMProvider(overrideProvider?: string): LLMProvider {
  const provider = overrideProvider || env.LLM_PROVIDER;

  if (provider === 'cloudflare') {
    return new CloudflareWorkersAIProvider();
  }

  if (provider === 'gemini') {
    return new GeminiProvider();
  }

  // Default: Model-First Architecture (SaralGati style: Tier 1 LoRA -> Tier 2 Gemini 34-key pool)
  return new ModelFirstProvider();
}

export function getEmbeddingProvider(overrideProvider?: string): EmbeddingProvider {
  const provider = overrideProvider || env.EMBEDDING_PROVIDER;

  if (provider === 'cloudflare') {
    return new CloudflareEmbeddingProvider();
  }

  return new GeminiEmbeddingProvider();
}

export {
  ModelFirstProvider,
  GeminiProvider,
  CloudflareWorkersAIProvider,
  GeminiEmbeddingProvider,
  CloudflareEmbeddingProvider
};
