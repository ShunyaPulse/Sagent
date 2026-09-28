import { EmbeddingProvider } from '../core/types.js';
import { env } from '../config/env.js';

export class CloudflareEmbeddingProvider implements EmbeddingProvider {
  public name = 'cloudflare';
  public dimensions = 768;
  private accountId: string;
  private apiToken: string;
  private modelName: string;

  constructor(accountId?: string, apiToken?: string, modelName?: string) {
    this.accountId = accountId || env.CLOUDFLARE_ACCOUNT_ID || '';
    this.apiToken = apiToken || env.CLOUDFLARE_API_TOKEN || '';
    this.modelName = modelName || env.CLOUDFLARE_EMBEDDING_MODEL;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.accountId || !this.apiToken) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for CloudflareEmbeddingProvider');
    }

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.modelName}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: [text]
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Cloudflare Embedding API error (${res.status}): ${errText}`);
    }

    const data: any = await res.json();
    const vector = data.result?.data?.[0];

    if (!vector || !Array.isArray(vector)) {
      throw new Error('Invalid embedding vector returned from Cloudflare Workers AI');
    }

    return vector;
  }
}
