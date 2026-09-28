import { GoogleGenAI } from '@google/genai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { LLMProvider, Message, AgentTool, StepOutput, ToolCall } from '../core/types.js';
import { env } from '../config/env.js';
import { GeminiKeyRotator } from './key-rotator.js';

/**
 * Filtered list of ONLY ACTIVE Google AI Studio models with Non-Zero Free Quotas
 * (Excludes all 0/0 quota models like gemini-2.5-pro, gemini-3.1-pro, gemini-2-flash)
 */
export const ACTIVE_GEMINI_MODELS_PROGRESSION = [
  // 1. High-Volume Flash-Lite Tier (15 RPM / 500 RPD per key)
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',

  // 2. High-Intelligence Flash Tier (5 RPM / 20 RPD per key)
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3-flash',
  'gemini-2.5-flash',

  // 3. High-Throughput Open Weights Tier (30 RPM / 14,400 RPD per key)
  'gemma-4-26b',
  'gemma-4-31b'
];

export class GeminiProvider implements LLMProvider {
  public name = 'gemini';
  private modelName: string;
  private rotator: GeminiKeyRotator;

  constructor(apiKey?: string, modelName?: string) {
    this.modelName = modelName || env.GEMINI_MODEL;
    this.rotator = GeminiKeyRotator.getInstance();
  }

  async generateStep(
    messages: Message[],
    tools: AgentTool<any>[],
    systemInstruction: string
  ): Promise<StepOutput> {
    const functionDeclarations = tools.map((t) => {
      const jsonSchema = zodToJsonSchema(t.parameters, { target: 'openApi3' }) as any;
      return {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'OBJECT',
          properties: jsonSchema.properties || {},
          required: jsonSchema.required || []
        }
      };
    });

    const contents = messages.map((m) => {
      const parts: any[] = [];
      if (m.content) {
        parts.push({ text: m.content });
      }
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          parts.push({
            functionCall: {
              name: tc.name,
              args: tc.arguments
            }
          });
        }
      }
      if (m.toolResults && m.toolResults.length > 0) {
        for (const tr of m.toolResults) {
          parts.push({
            functionResponse: {
              name: tr.name,
              response: { output: tr.output, isError: tr.isError }
            }
          });
        }
      }

      return {
        role: m.role === 'model' ? 'model' : 'user',
        parts
      };
    });

    // Multi-Model Escalation across ONLY Active Non-Zero Models
    const modelsToTry = [
      this.modelName,
      ...ACTIVE_GEMINI_MODELS_PROGRESSION.filter((m) => m !== this.modelName)
    ];
    let lastError: any;

    for (const model of modelsToTry) {
      try {
        return await this.rotator.executeWithRotation(async (apiKey) => {
          const ai = new GoogleGenAI({ apiKey });
          const response = await ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction,
              temperature: 0.2,
              tools: functionDeclarations.length > 0 ? [{ functionDeclarations: functionDeclarations as any }] : undefined
            }
          });

          const toolCalls: ToolCall[] = [];
          let thoughtText: string | undefined;

          if (response.functionCalls && response.functionCalls.length > 0) {
            for (const fc of response.functionCalls) {
              toolCalls.push({
                id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                name: fc.name || 'unknown_tool',
                arguments: (fc.args as Record<string, any>) || {}
              });
            }
          }

          if (response.text) {
            thoughtText = response.text;
          }

          return {
            thought: thoughtText,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            finalAnswer: toolCalls.length === 0 ? thoughtText : undefined,
            tokensUsed: response.usageMetadata?.totalTokenCount || 0
          };
        });
      } catch (err: any) {
        lastError = err;
        console.warn(`⚠️ Active model "${model}" hit quota/error. Auto-escalating to next active model...`);
      }
    }

    throw lastError;
  }

  async streamFinalAnswer(
    messages: Message[],
    systemInstruction: string,
    onToken: (token: string) => void
  ): Promise<{ fullText: string; tokensUsed: number }> {
    const contents = messages.map((m) => ({
      role: m.role === 'model' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const modelsToTry = [
      this.modelName,
      ...ACTIVE_GEMINI_MODELS_PROGRESSION.filter((m) => m !== this.modelName)
    ];
    let lastError: any;

    for (const model of modelsToTry) {
      try {
        return await this.rotator.executeWithRotation(async (apiKey) => {
          const ai = new GoogleGenAI({ apiKey });
          const responseStream = await ai.models.generateContentStream({
            model,
            contents,
            config: {
              systemInstruction,
              temperature: 0.3
            }
          });

          let fullText = '';
          let tokensUsed = 0;

          for await (const chunk of responseStream) {
            const text = chunk.text || '';
            if (text) {
              fullText += text;
              onToken(text);
            }
            if (chunk.usageMetadata?.totalTokenCount) {
              tokensUsed = chunk.usageMetadata.totalTokenCount;
            }
          }

          return { fullText, tokensUsed };
        });
      } catch (err: any) {
        lastError = err;
        console.warn(`⚠️ Stream on model "${model}" hit error. Escalating to next active model...`);
      }
    }

    throw lastError;
  }
}
