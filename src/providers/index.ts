import { LLMProvider, EmbeddingProvider } from '../core/types.js';
import { GeminiProvider } from './gemini.js';
import { CloudflareWorkersAIProvider } from './cloudflare.js';
import { GeminiEmbeddingProvider } from './embedding-gemini.js';
import { CloudflareEmbeddingProvider } from './embedding-cloudflare.js';
import { env } from '../config/env.js';

export function getLLMProvider(overrideProvider?: string): LLMProvider {
  const provider = overrideProvider || env.LLM_PROVIDER;

  if (provider === 'cloudflare') {
    return new CloudflareWorkersAIProvider();
  }

  return new GeminiProvider();
}

export function getEmbeddingProvider(overrideProvider?: string): EmbeddingProvider {
  const provider = overrideProvider || env.EMBEDDING_PROVIDER;

  if (provider === 'cloudflare') {
    return new CloudflareEmbeddingProvider();
  }

  return new GeminiEmbeddingProvider();
}

export {
  GeminiProvider,
  CloudflareWorkersAIProvider,
  GeminiEmbeddingProvider,
  CloudflareEmbeddingProvider
};
