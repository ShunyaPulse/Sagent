import { GoogleGenAI } from '@google/genai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { LLMProvider, Message, AgentTool, StepOutput, ToolCall } from '../core/types.js';
import { env } from '../config/env.js';
import { GeminiKeyRotator } from './key-rotator.js';

const MODEL_PROGRESSION = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-1.5-flash',
  'gemini-1.5-pro'
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

    // Multi-Model Escalation with 34-key rotation pool
    const modelsToTry = [this.modelName, ...MODEL_PROGRESSION.filter((m) => m !== this.modelName)];
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
        console.warn(`⚠️ Model "${model}" failed or exhausted across keys. Escalating to next model in progression...`);
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

    return await this.rotator.executeWithRotation(async (apiKey) => {
      const ai = new GoogleGenAI({ apiKey });
      const responseStream = await ai.models.generateContentStream({
        model: this.modelName,
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
  }
}
