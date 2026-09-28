/**
 * Sagent Model-First Dual-Tier Execution Engine
 * (Modeled directly after SaralGati cloud_self_learning.py and aiFallback.ts)
 *
 * Hierarchy:
 * - Tier 1: Custom Fine-Tuned LoRA on Cloudflare Workers AI (@cf/meta/llama-3.1-8b-instruct)
 * - Tier 2: Google Gemini AI Studio 34-Key Pool & Model-First Progression:
 *          [gemini-3.8-flash -> gemini-3.7-flash -> gemini-3.6-flash -> gemini-3.5-flash ->
 *           gemini-3-flash-preview -> gemini-3.5-flash-lite -> gemini-3.1-flash-lite]
 */

import { LLMProvider, Message, AgentTool, StepOutput } from "../core/types.js";
import { CloudflareWorkersAIProvider } from "./cloudflare.js";
import { GeminiProvider, SARALGATI_CANDIDATE_MODELS } from "./gemini.js";
import { GeminiKeyRotator } from "./key-rotator.js";
import { env } from "../config/env.js";

export { SARALGATI_CANDIDATE_MODELS };

export class ModelFirstProvider implements LLMProvider {
  public name = "model-first";
  private cloudflareProvider: CloudflareWorkersAIProvider | null = null;
  private geminiProvider: GeminiProvider;
  private keyRotator: GeminiKeyRotator;

  constructor() {
    this.geminiProvider = new GeminiProvider();
    this.keyRotator = GeminiKeyRotator.getInstance();

    const hasCloudflare = Boolean(
      env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN,
    );

    if (hasCloudflare) {
      this.cloudflareProvider = new CloudflareWorkersAIProvider();
    }
  }

  async generateStep(
    messages: Message[],
    tools: AgentTool<any>[],
    systemInstruction: string,
  ): Promise<StepOutput> {
    // -------------------------------------------------------------
    // Tier 1: Attempt Custom LoRA on Cloudflare Workers AI First
    // -------------------------------------------------------------
    if (
      this.cloudflareProvider &&
      (env.LLM_PROVIDER === "cloudflare" || env.CLOUDFLARE_LORA_NAME)
    ) {
      try {
        console.log(
          "⚡ [Tier 1: Cloudflare LoRA] Generating step with custom model...",
        );
        const cfResult = await this.cloudflareProvider.generateStep(
          messages,
          tools,
          systemInstruction,
        );
        if (
          cfResult.finalAnswer ||
          (cfResult.toolCalls && cfResult.toolCalls.length > 0)
        ) {
          return cfResult;
        }
      } catch (cfErr: any) {
        console.warn(
          `⚠️ [Tier 1: Cloudflare LoRA] Failed: ${cfErr.message}. Escalating to Tier 2 Gemini Candidates...`,
        );
      }
    }

    // -------------------------------------------------------------
    // Tier 2: Gemini Model-First Candidates & 34-Key Matrix Progression
    // -------------------------------------------------------------
    return await this.geminiProvider.generateStep(
      messages,
      tools,
      systemInstruction,
    );
  }

  async streamFinalAnswer(
    messages: Message[],
    systemInstruction: string,
    onToken: (token: string) => void,
  ): Promise<{ fullText: string; tokensUsed: number }> {
    if (this.cloudflareProvider && env.LLM_PROVIDER === "cloudflare") {
      try {
        return await this.cloudflareProvider.streamFinalAnswer(
          messages,
          systemInstruction,
          onToken,
        );
      } catch (cfErr: any) {
        console.warn(
          `⚠️ Cloudflare stream failed: ${cfErr.message}. Escalating to Gemini Model-First...`,
        );
      }
    }

    return await this.geminiProvider.streamFinalAnswer(
      messages,
      systemInstruction,
      onToken,
    );
  }
}
