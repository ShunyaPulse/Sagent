/**
 * Sagent Model-First Exhaustive Multi-Key Rotator
 * Modeled after SaralGati Autonomous Self-Learning Pipeline (scripts/cloud_self_learning.py)
 *
 * Flow:
 * 1. Try highest quality model (gemini-3.8-flash) across ALL 34 keys.
 * 2. On 429 rate limit: rotate to next key on the SAME model.
 * 3. On 503/500 high demand: Blacklist that model for this run and FAST-SWITCH to next model immediately.
 * 4. Only after ALL 34 keys are exhausted on a model, fall through to the next model in progression.
 */

import { env } from "../config/env.js";

export const SARALGATI_CANDIDATE_MODELS = [
  "gemini-2.5-flash", // Production default, stable tool calling (5 RPM / 20 RPD)
  "gemini-2.5-flash-lite", // Ultra-fast 2.5 lite (10 RPM / 20 RPD)
  "gemini-3.8-flash", // Latest stable, highest quality (5 RPM / 20 RPD)
  "gemini-3.7-flash", // Previous gen, highly capable (5 RPM / 20 RPD)
  "gemini-3.6-flash", // Solid fast fallback (5 RPM / 20 RPD)
  "gemini-3.5-flash", // Widely available (10 RPM / 20 RPD)
  "gemini-3-flash-preview", // Gemini 3 Flash Preview (5 RPM / 20 RPD)
  "gemini-3.5-flash-lite", // High-throughput lite (30 RPM / 1500 RPD)
  "gemini-3.1-flash-lite", // Ultra-lite fallback (30 RPM / 1500 RPD)
];

export class GeminiKeyRotator {
  private static instance: GeminiKeyRotator;
  private keys: string[] = [];
  private currentKeyIndex = 0;

  private constructor() {
    this.reloadKeys();
  }

  public reloadKeys(): void {
    const rawKeys = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";
    this.keys = rawKeys
      .split(",")
      .map((k) => k.trim().replace(/^["']|["']$/g, ""))
      .filter((k) => k.length > 0);

    if (this.keys.length === 0) {
      if (process.env.DEBUG_ROTATOR === "true") {
        console.warn("⚠️ No Gemini API keys found in GEMINI_API_KEY.");
      }
    } else if (process.env.DEBUG_ROTATOR === "true") {
      console.log(
        `🔑 Loaded ${this.keys.length} Gemini API Key(s) for Model-First Exhaustive Rotation.`,
      );
    }
  }

  public static getInstance(): GeminiKeyRotator {
    if (!GeminiKeyRotator.instance) {
      GeminiKeyRotator.instance = new GeminiKeyRotator();
    }
    return GeminiKeyRotator.instance;
  }

  public getKeys(): string[] {
    return [...this.keys];
  }

  public getKeyCount(): number {
    return this.keys.length;
  }

  public async executeWithRotation<T>(
    operation: (apiKey: string) => Promise<T>,
  ): Promise<T> {
    if (this.keys.length === 0) {
      throw new Error("No GEMINI_API_KEY configured.");
    }
    let lastError: any;
    for (let i = 0; i < this.keys.length; i++) {
      const keyIdx = (this.currentKeyIndex + i) % this.keys.length;
      const apiKey = this.keys[keyIdx];
      try {
        const res = await operation(apiKey);
        this.currentKeyIndex = (keyIdx + 1) % this.keys.length;
        return res;
      } catch (err: any) {
        lastError = err;
        const msg = (err.message || "").toLowerCase();
        if (
          msg.includes("429") ||
          msg.includes("quota") ||
          msg.includes("resource_exhausted")
        ) {
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /**
   * Model-First Exhaustive Execution:
   * Tries ALL keys on Model 1, then ALL keys on Model 2, etc. (No blacklisting)
   */
  public async executeModelFirst<T>(
    operation: (modelName: string, apiKey: string) => Promise<T>,
    preferredModel?: string,
  ): Promise<{ result: T; modelUsed: string; keyIndexUsed: number }> {
    if (this.keys.length === 0) {
      throw new Error("No GEMINI_API_KEY configured in environment.");
    }

    const candidateModels = preferredModel
      ? [
          preferredModel,
          ...SARALGATI_CANDIDATE_MODELS.filter((m) => m !== preferredModel),
        ]
      : SARALGATI_CANDIDATE_MODELS;

    let lastError: any;

    for (const modelName of candidateModels) {
      let modelExhausted = true;

      for (let i = 0; i < this.keys.length; i++) {
        const keyIdx = (this.currentKeyIndex + i) % this.keys.length;
        const apiKey = this.keys[keyIdx];

        try {
          const result = await operation(modelName, apiKey);

          // Success: advance pointer for round-robin load distribution across projects
          this.currentKeyIndex = (keyIdx + 1) % this.keys.length;
          return { result, modelUsed: modelName, keyIndexUsed: keyIdx };
        } catch (err: any) {
          lastError = err;
          const msg = (err.message || "").toLowerCase();
          const status =
            err.status || (err.response ? err.response.status : null);

          // 1. 503 / 500 / Overloaded / High Demand: Google datacenter capacity issue on this model.
          // Fast-switch immediately to next candidate model without burning all 34 keys.
          if (
            status === 503 ||
            status === 500 ||
            status === 502 ||
            status === 504 ||
            msg.includes("503") ||
            msg.includes("high demand") ||
            msg.includes("overloaded")
          ) {
            if (process.env.DEBUG_ROTATOR === "true") {
              console.log(
                `  ⚡ ${modelName} is experiencing temporary high demand (503). Fast-switching to next candidate model...`,
              );
            }
            modelExhausted = false;
            break;
          }

          // 2. 404 Model Not Found on this endpoint: jump to next model immediately
          if (
            status === 404 ||
            msg.includes("404") ||
            msg.includes("not found")
          ) {
            modelExhausted = false;
            break;
          }

          // 3. 429 Rate Limit / Quota Exhaustion on this specific project key:
          // Rotate to the next project key (since each key has its own independent project quota).
          if (
            status === 429 ||
            msg.includes("429") ||
            msg.includes("resource_exhausted") ||
            msg.includes("quota")
          ) {
            if (process.env.DEBUG_ROTATOR === "true") {
              console.log(
                `  ⏭ Key [${keyIdx + 1}/${this.keys.length}] project quota reached on ${modelName}, rotating to next project key...`,
              );
            }
            continue;
          }

          // Other error: try next key
          continue;
        }
      }

      if (modelExhausted) {
        if (process.env.DEBUG_ROTATOR === "true") {
          console.warn(
            `  ❌ All ${this.keys.length} keys exhausted on ${modelName}. Falling to next model...`,
          );
        }
      }
    }

    throw (
      lastError || new Error("All candidate models and all API keys exhausted.")
    );
  }
}
