import { GoogleGenAI } from '@google/genai';
import { EmbeddingProvider } from '../core/types.js';
import { GeminiKeyRotator } from './key-rotator.js';

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  public name = 'gemini';
  public dimensions = 768;
  private rotator: GeminiKeyRotator;

  constructor(apiKey?: string) {
    this.rotator = GeminiKeyRotator.getInstance();
  }

  async embed(text: string): Promise<number[]> {
    return await this.rotator.executeWithRotation(async (apiKey) => {
      const ai = new GoogleGenAI({ apiKey });
      const res = await ai.models.embedContent({
        model: 'text-embedding-004',
        contents: text
      });

      const values = (res as any).embedding?.values || res.embeddings?.[0]?.values;

      if (!values) {
        throw new Error('No embedding vector returned by Gemini text-embedding-004');
      }

      return values;
    });
  }
}
