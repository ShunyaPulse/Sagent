import {
  LLMProvider,
  Message,
  AgentTool,
  StepOutput,
  ToolCall,
} from "../core/types.js";
import { env } from "../config/env.js";
import { zodToJsonSchema } from "zod-to-json-schema";

export class CloudflareWorkersAIProvider implements LLMProvider {
  public name = "cloudflare";
  private accountId: string;
  private apiToken: string;
  private modelName: string;
  private loraName: string;

  constructor(
    accountId?: string,
    apiToken?: string,
    modelName?: string,
    loraName?: string,
  ) {
    this.accountId = accountId || env.CLOUDFLARE_ACCOUNT_ID || "";
    this.apiToken = apiToken || env.CLOUDFLARE_API_TOKEN || "";
    this.modelName = modelName || env.CLOUDFLARE_AI_MODEL;
    this.loraName = loraName || env.CLOUDFLARE_LORA_NAME || "";

    if (!this.accountId || !this.apiToken) {
      console.warn(
        "⚠️ CloudflareWorkersAIProvider initialized without CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN",
      );
    }
  }

  async generateStep(
    messages: Message[],
    tools: AgentTool[],
    systemInstruction: string,
  ): Promise<StepOutput> {
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.modelName}`;

    // Prepare JSON tool descriptions
    const toolSpecs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.parameters),
    }));

    const enrichedSystemPrompt = `
${systemInstruction}

Available Tools:
${JSON.stringify(toolSpecs, null, 2)}

CRITICAL ACTION RULES:
- If the user request requires an action (e.g. writing/creating a file, reading a file, searching documents, or calculations), you MUST call the appropriate tool.
- You CANNOT write or modify files by simply outputting markdown text. You MUST output a tool call for "file_writer".
- Respond in strict JSON format matching ONE of these two schemas:

1. When calling a tool (e.g. to create/write a file):
{
  "thought": "Your reasoning why you need this tool",
  "tool": "name_of_tool",
  "arguments": { ...tool parameters... }
}

2. Only when all required actions have been performed and you are answering the user:
{
  "thought": "Your internal conclusion",
  "finalAnswer": "Your complete Markdown answer to the user"
}
`;

    // Map conversation messages to prompt
    const promptMessages = [
      { role: "system", content: enrichedSystemPrompt },
      ...messages.map((m) => {
        let text = m.content || "";
        if (
          m.toolCalls &&
          m.toolCalls.length > 0 &&
          !text.includes(m.toolCalls[0].name)
        ) {
          text = JSON.stringify({
            thought: m.content || undefined,
            tool: m.toolCalls[0].name,
            arguments: m.toolCalls[0].arguments,
          });
        }
        if (m.toolResults && m.toolResults.length > 0) {
          text += `\nTool Observations:\n${JSON.stringify(m.toolResults)}`;
        }
        return {
          role: m.role === "model" ? "assistant" : "user",
          content: text || " ",
        };
      }),
    ];

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: promptMessages,
        max_tokens: 1024,
        temperature: 0.1,
        ...(this.loraName ? { lora: this.loraName } : {}),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `Cloudflare Workers AI API error (${res.status}): ${errText}`,
      );
    }

    const data: any = await res.json();
    const rawResult =
      data.result?.response ??
      data.result?.choices?.[0]?.message?.content ??
      "";

    let parsed: any = null;

    if (typeof rawResult === "object" && rawResult !== null) {
      parsed = rawResult;
    } else if (typeof rawResult === "string") {
      try {
        const cleanJson = rawResult
          .replace(/```json\s*/gi, "")
          .replace(/```\s*$/gi, "")
          .trim();
        parsed = JSON.parse(cleanJson);
      } catch {
        // Try extracting any { ... } JSON substring in the output
        const jsonBlockMatch = rawResult.match(/\{[\s\S]*\}/);
        if (jsonBlockMatch) {
          try {
            parsed = JSON.parse(jsonBlockMatch[0]);
          } catch {}
        }

        if (!parsed) {
          // Regex fallback if JSON.parse fails on unescaped newlines or syntax quirks
          const toolMatch = rawResult.match(/"tool"\s*:\s*"([^"]+)"/);
          const answerMatch = rawResult.match(
            /"finalAnswer"\s*:\s*"([\s\S]*?)"\s*\}/,
          );
          const thoughtMatch = rawResult.match(/"thought"\s*:\s*"([\s\S]*?)"/);

          if (toolMatch) {
            let args = {};
            const argsMatch = rawResult.match(
              /"arguments"\s*:\s*(\{[\s\S]*?\})/,
            );
            if (argsMatch) {
              try {
                args = JSON.parse(argsMatch[1]);
              } catch {}
            }
            parsed = {
              tool: toolMatch[1],
              arguments: args,
              thought: thoughtMatch ? thoughtMatch[1] : undefined,
            };
          } else if (answerMatch) {
            parsed = {
              finalAnswer: answerMatch[1],
              thought: thoughtMatch ? thoughtMatch[1] : undefined,
            };
          }
        }
      }
    }

    if (parsed && typeof parsed === "object") {
      if (parsed.tool) {
        const toolCalls: ToolCall[] = [
          {
            id: `cf_call_${Date.now()}`,
            name: parsed.tool,
            arguments: parsed.arguments || {},
          },
        ];
        return {
          thought: parsed.thought,
          toolCalls,
        };
      }

      if (parsed.finalAnswer) {
        return {
          thought: parsed.thought,
          finalAnswer: parsed.finalAnswer,
        };
      }
    }

    // Check if fallback text contains an embedded tool call
    const embeddedToolMatch =
      typeof rawResult === "string"
        ? rawResult.match(/"tool"\s*:\s*"([^"]+)"/)
        : null;
    if (embeddedToolMatch) {
      let args = {};
      const argsMatch = (rawResult as string).match(
        /"arguments"\s*:\s*(\{[\s\S]*?\})/,
      );
      if (argsMatch) {
        try {
          args = JSON.parse(argsMatch[1]);
        } catch {}
      }
      return {
        toolCalls: [
          {
            id: `cf_call_${Date.now()}`,
            name: embeddedToolMatch[1],
            arguments: args,
          },
        ],
      };
    }

    // Fallback if model gave raw text without JSON wrapping
    let fallbackAnswer =
      typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);

    // If fallback string contains a json with finalAnswer, extract it
    if (fallbackAnswer.includes('"finalAnswer"')) {
      const match = fallbackAnswer.match(
        /"finalAnswer"\s*:\s*"([\s\S]*?)"\s*\}/,
      );
      if (match && match[1]) {
        fallbackAnswer = match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
      }
    }

    return {
      finalAnswer: fallbackAnswer,
    };
  }

  async streamFinalAnswer(
    messages: Message[],
    systemInstruction: string,
    onToken: (token: string) => void,
  ): Promise<{ fullText: string; tokensUsed: number }> {
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.modelName}`;

    const promptMessages = [
      { role: "system", content: systemInstruction },
      ...messages.map((m) => ({
        role: m.role === "model" ? "assistant" : "user",
        content: m.content,
      })),
    ];

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: promptMessages,
        max_tokens: 2048,
        stream: true,
        ...(this.loraName ? { lora: this.loraName } : {}),
      }),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text();
      throw new Error(`Cloudflare stream error: ${errText}`);
    }

    // Read SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const parsed = JSON.parse(line.slice(6));
            const token = parsed.response || "";
            if (token) {
              fullText += token;
              onToken(token);
            }
          } catch {
            // ignore non-json SSE lines
          }
        }
      }
    }

    return { fullText, tokensUsed: 0 };
  }
}
