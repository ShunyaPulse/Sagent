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

import { env } from '../config/env.js';

export const SARALGATI_CANDIDATE_MODELS = [
  'gemini-3.8-flash',       // Latest stable, best quality  (5 RPM / 20 RPD free)
  'gemini-3.7-flash',       // Previous gen, highly capable (5 RPM / 20 RPD free)
  'gemini-3.6-flash',       // Solid fast fallback          (5 RPM / 20 RPD free)
  'gemini-3.5-flash',       // Widely available            (10 RPM / 20 RPD free)
  'gemini-3-flash-preview', // Gemini 3 Flash (AI Studio)   (5 RPM / 20 RPD free)
  'gemini-3.5-flash-lite',  // High-throughput lite         (15 RPM / 500 RPD free)
  'gemini-3.1-flash-lite',  // Last-resort ultra-lite       (15 RPM / 500 RPD free)
];

export class GeminiKeyRotator {
  private static instance: GeminiKeyRotator;
  private keys: string[] = [];
  private currentKeyIndex = 0;
  private blacklistedModels: Map<string, number> = new Map(); // model -> unblacklist timestamp

  private constructor() {
    const rawKeys = env.GEMINI_API_KEY || '';
    this.keys = rawKeys
      .split(',')
      .map((k) => k.trim().replace(/^["']|["']$/g, ''))
      .filter((k) => k.length > 0);

    if (this.keys.length === 0) {
      console.warn('⚠️ No Gemini API keys found in GEMINI_API_KEY.');
    } else {
      console.log(`🔑 Loaded ${this.keys.length} Gemini API Key(s) for Model-First Exhaustive Rotation.`);
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

  private isModelBlacklisted(model: string): boolean {
    const expiresAt = this.blacklistedModels.get(model);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      this.blacklistedModels.delete(model);
      return false;
    }
    return true;
  }

  private blacklistModel(model: string, durationMs = 60000) {
    this.blacklistedModels.set(model, Date.now() + durationMs);
  }

  public async executeWithRotation<T>(operation: (apiKey: string) => Promise<T>): Promise<T> {
    if (this.keys.length === 0) {
      throw new Error('No GEMINI_API_KEY configured.');
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
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('429') || msg.includes('quota') || msg.includes('resource_exhausted')) {
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /**
   * Model-First Exhaustive Execution:
   * Tries ALL keys on Model 1, then ALL keys on Model 2, etc.
   */
  public async executeModelFirst<T>(
    operation: (modelName: string, apiKey: string) => Promise<T>,
    preferredModel?: string
  ): Promise<{ result: T; modelUsed: string; keyIndexUsed: number }> {
    if (this.keys.length === 0) {
      throw new Error('No GEMINI_API_KEY configured in environment.');
    }

    const candidateModels = preferredModel
      ? [preferredModel, ...SARALGATI_CANDIDATE_MODELS.filter((m) => m !== preferredModel)]
      : SARALGATI_CANDIDATE_MODELS;

    let lastError: any;

    for (const modelName of candidateModels) {
      if (this.isModelBlacklisted(modelName)) {
        continue; // Skip 503 high-demand models
      }

      let modelExhausted = true;

      for (let i = 0; i < this.keys.length; i++) {
        const keyIdx = (this.currentKeyIndex + i) % this.keys.length;
        const apiKey = this.keys[keyIdx];

        try {
          const result = await operation(modelName, apiKey);

          // Success: advance pointer for round-robin load distribution
          this.currentKeyIndex = (keyIdx + 1) % this.keys.length;
          return { result, modelUsed: modelName, keyIndexUsed: keyIdx };
        } catch (err: any) {
          lastError = err;
          const msg = (err.message || '').toLowerCase();
          const status = err.status || (err.response ? err.response.status : null);

          // 503 / 500 High Demand: Blacklist model and fast-switch to next model
          if (status === 503 || status === 500 || status === 502 || status === 504 || msg.includes('503') || msg.includes('high demand') || msg.includes('overloaded')) {
            this.blacklistModel(modelName);
            console.warn(`  ⚡ ${modelName} is experiencing high demand (${status || 503}). Blacklisting for 60s, fast-switching to next candidate model...`);
            modelExhausted = false;
            break; // Break key loop, jump to next model immediately!
          }

          // 429 Rate Limit on this specific key: Try next key on SAME model
          if (status === 429 || msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('quota')) {
            console.log(`  ⏭ Key [${keyIdx + 1}/${this.keys.length}] rate-limited on ${modelName}, trying next key...`);
            continue;
          }

          // 404 Model Not Found
          if (status === 404 || msg.includes('404') || msg.includes('not found')) {
            this.blacklistModel(modelName, 300000); // 5 min
            break;
          }

          // Other error: try next key
          continue;
        }
      }

      if (modelExhausted) {
        console.warn(`  ❌ All ${this.keys.length} keys exhausted on ${modelName}. Falling to next model...`);
      }
    }

    throw lastError || new Error('All candidate models and all API keys exhausted.');
  }
}
