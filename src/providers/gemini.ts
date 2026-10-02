import { GoogleGenAI } from "@google/genai";
import { toolParametersToJsonSchema } from "../tools/schema.js";
import {
  LLMProvider,
  Message,
  AgentTool,
  StepOutput,
  ToolCall,
} from "../core/types.js";
import { env } from "../config/env.js";
import { GeminiKeyRotator, SARALGATI_CANDIDATE_MODELS } from "./key-rotator.js";

export { SARALGATI_CANDIDATE_MODELS };

export class GeminiProvider implements LLMProvider {
  public name = "gemini";
  private preferredModel: string;
  private lastWorkingModel: string | null = null;
  private rotator: GeminiKeyRotator;

  constructor(apiKey?: string, modelName?: string) {
    this.preferredModel = modelName || env.GEMINI_MODEL;
    this.rotator = GeminiKeyRotator.getInstance();
  }

  async generateStep(
    messages: Message[],
    tools: AgentTool<any>[],
    systemInstruction: string,
  ): Promise<StepOutput> {
    const functionDeclarations = tools.map((t) => {
      const jsonSchema = toolParametersToJsonSchema(t.parameters);
      return {
        name: t.name,
        description: t.description,
        parameters: {
          type: "OBJECT",
          properties: jsonSchema.properties || {},
          required: jsonSchema.required || [],
        },
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
              args: tc.arguments,
            },
          });
        }
      }
      if (m.toolResults && m.toolResults.length > 0) {
        for (const tr of m.toolResults) {
          parts.push({
            functionResponse: {
              name: tr.name,
              response: { output: tr.output, isError: tr.isError },
            },
          });
        }
      }

      if (parts.length === 0) {
        parts.push({ text: " " });
      }

      return {
        role: m.role === "model" ? "model" : "user",
        parts,
      };
    });

    // Execute via Model-First Exhaustive Rotation (SaralGati Cloud Self-Learning pattern)
    const { result, modelUsed, keyIndexUsed } =
      await this.rotator.executeModelFirst(async (modelName, apiKey) => {
        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
          model: modelName,
          contents,
          config: {
            systemInstruction,
            temperature: 0.2,
            tools:
              functionDeclarations.length > 0
                ? [{ functionDeclarations: functionDeclarations as any }]
                : undefined,
          },
        });

        const toolCalls: ToolCall[] = [];
        let thoughtText: string | undefined;

        if (response.functionCalls && response.functionCalls.length > 0) {
          for (const fc of response.functionCalls) {
            toolCalls.push({
              id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
              name: fc.name || "unknown_tool",
              arguments: (fc.args as Record<string, any>) || {},
            });
          }
        }

        try {
          const textPart = response.candidates?.[0]?.content?.parts?.find(
            (p: any) => typeof p.text === "string",
          );
          if (textPart && textPart.text) {
            thoughtText = textPart.text;
          } else if (response.text) {
            thoughtText = response.text;
          }
        } catch {
          thoughtText = undefined;
        }

        return {
          thought: thoughtText,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finalAnswer: toolCalls.length === 0 ? thoughtText : undefined,
          tokensUsed: response.usageMetadata?.totalTokenCount || 0,
        };
      }, this.lastWorkingModel || this.preferredModel);

    this.lastWorkingModel = modelUsed;
    return result;
  }

  async streamFinalAnswer(
    messages: Message[],
    systemInstruction: string,
    onToken: (token: string) => void,
  ): Promise<{ fullText: string; tokensUsed: number }> {
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
              args: tc.arguments,
            },
          });
        }
      }
      if (m.toolResults && m.toolResults.length > 0) {
        for (const tr of m.toolResults) {
          parts.push({
            functionResponse: {
              name: tr.name,
              response: { output: tr.output, isError: tr.isError },
            },
          });
        }
      }

      // Ensure parts is never empty
      if (parts.length === 0) {
        parts.push({ text: " " });
      }

      return {
        role: m.role === "model" ? "model" : "user",
        parts,
      };
    });

    const { result, modelUsed } = await this.rotator.executeModelFirst(
      async (modelName, apiKey) => {
        const ai = new GoogleGenAI({ apiKey });
        const responseStream = await ai.models.generateContentStream({
          model: modelName,
          contents,
          config: {
            systemInstruction,
            temperature: 0.3,
          },
        });

        let fullText = "";
        let tokensUsed = 0;

        for await (const chunk of responseStream) {
          const text = chunk.text || "";
          if (text) {
            fullText += text;
            onToken(text);
          }
          if (chunk.usageMetadata?.totalTokenCount) {
            tokensUsed = chunk.usageMetadata.totalTokenCount;
          }
        }

        return { fullText, tokensUsed };
      },
      this.lastWorkingModel || this.preferredModel,
    );

    this.lastWorkingModel = modelUsed;
    return result;
  }
}
