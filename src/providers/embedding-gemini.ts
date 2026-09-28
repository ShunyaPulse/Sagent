import { GoogleGenAI } from "@google/genai";
import { EmbeddingProvider } from "../core/types.js";
import { GeminiKeyRotator } from "./key-rotator.js";
import { CloudflareEmbeddingProvider } from "./embedding-cloudflare.js";

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  public name = "gemini";
  public dimensions = 768;
  private rotator: GeminiKeyRotator;
  private cfFallback?: CloudflareEmbeddingProvider;

  constructor(apiKey?: string) {
    this.rotator = GeminiKeyRotator.getInstance();
  }

  async embed(text: string): Promise<number[]> {
    try {
      return await this.rotator.executeWithRotation(async (apiKey) => {
        const ai = new GoogleGenAI({ apiKey });
        const res = await ai.models.embedContent({
          model: "text-embedding-004",
          contents: text,
        });

        const values =
          (res as any).embedding?.values || res.embeddings?.[0]?.values;

        if (!values) {
          throw new Error(
            "No embedding vector returned by Gemini text-embedding-004",
          );
        }

        return values;
      });
    } catch (geminiErr: any) {
      if (!this.cfFallback) {
        this.cfFallback = new CloudflareEmbeddingProvider();
      }
      return await this.cfFallback.embed(text);
    }
  }
}
