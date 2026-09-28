import { GoogleGenAI } from "@google/genai";
import { EmbeddingProvider } from "../core/types.js";
import { env } from "../config/env.js";

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  public name = "gemini";
  public dimensions = 768;
  private ai: GoogleGenAI;

  constructor(apiKey?: string) {
    const key = apiKey || env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY is required for GeminiEmbeddingProvider");
    }
    this.ai = new GoogleGenAI({ apiKey: key });
  }

  async embed(text: string): Promise<number[]> {
    const res = await this.ai.models.embedContent({
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
  }
}
