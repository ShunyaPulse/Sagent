import { env } from '../config/env.js';

export class GeminiKeyRotator {
  private static instance: GeminiKeyRotator;
  private keys: string[] = [];
  private currentIndex = 0;

  private constructor() {
    const rawKeys = env.GEMINI_API_KEY || '';
    this.keys = rawKeys
      .split(',')
      .map((k) => k.trim().replace(/^["']|["']$/g, ''))
      .filter((k) => k.length > 0);

    if (this.keys.length === 0) {
      console.warn('⚠️ No Gemini API keys found in GEMINI_API_KEY.');
    } else {
      console.log(`🔑 Loaded ${this.keys.length} Gemini API Key(s) into Rotator Pool.`);
    }
  }

  public static getInstance(): GeminiKeyRotator {
    if (!GeminiKeyRotator.instance) {
      GeminiKeyRotator.instance = new GeminiKeyRotator();
    }
    return GeminiKeyRotator.instance;
  }

  public getNextKey(): string {
    if (this.keys.length === 0) {
      throw new Error('GEMINI_API_KEY is not configured.');
    }
    const key = this.keys[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    return key;
  }

  public getAllKeys(): string[] {
    return [...this.keys];
  }

  public getKeyCount(): number {
    return this.keys.length;
  }

  /**
   * Executes an asynchronous operation with automatic key rotation and retry on 429/quota errors.
   */
  public async executeWithRotation<T>(operation: (apiKey: string) => Promise<T>): Promise<T> {
    const attempts = Math.min(this.keys.length, 5); // Try up to 5 different keys on error
    let lastError: any;

    for (let i = 0; i < attempts; i++) {
      const apiKey = this.getNextKey();
      try {
        return await operation(apiKey);
      } catch (err: any) {
        lastError = err;
        const msg = err.message || '';
        const isRateLimit = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota exceeded');
        
        if (isRateLimit && this.keys.length > 1) {
          console.warn(`⚠️ Rate limit hit on key index ${(this.currentIndex - 1 + this.keys.length) % this.keys.length}. Auto-rotating to next key in pool...`);
          continue; // Rotate to next key
        }

        throw err;
      }
    }

    throw lastError;
  }
}
