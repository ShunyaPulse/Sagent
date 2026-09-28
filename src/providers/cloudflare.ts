import { LLMProvider, Message, AgentTool, StepOutput, ToolCall } from '../core/types.js';
import { env } from '../config/env.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

export class CloudflareWorkersAIProvider implements LLMProvider {
  public name = 'cloudflare';
  private accountId: string;
  private apiToken: string;
  private modelName: string;

  constructor(accountId?: string, apiToken?: string, modelName?: string) {
    this.accountId = accountId || env.CLOUDFLARE_ACCOUNT_ID || '';
    this.apiToken = apiToken || env.CLOUDFLARE_API_TOKEN || '';
    this.modelName = modelName || env.CLOUDFLARE_AI_MODEL;

    if (!this.accountId || !this.apiToken) {
      console.warn('⚠️ CloudflareWorkersAIProvider initialized without CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
    }
  }

  async generateStep(
    messages: Message[],
    tools: AgentTool[],
    systemInstruction: string
  ): Promise<StepOutput> {
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.modelName}`;

    // Prepare JSON tool descriptions
    const toolSpecs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.parameters)
    }));

    const enrichedSystemPrompt = `
${systemInstruction}

Available Tools:
${JSON.stringify(toolSpecs, null, 2)}

You must respond in strict JSON format matching ONE of these two schemas:
1. If you need to call a tool:
{
  "thought": "Your reasoning why you need this tool",
  "tool": "name_of_tool",
  "arguments": { ...tool parameters... }
}

2. If you have enough information to answer the user:
{
  "thought": "Your internal conclusion",
  "finalAnswer": "Your complete Markdown answer to the user"
}
`;

    // Map conversation messages to prompt
    const promptMessages = [
      { role: 'system', content: enrichedSystemPrompt },
      ...messages.map((m) => {
        let text = m.content;
        if (m.toolResults && m.toolResults.length > 0) {
          text += `\nTool Observations:\n${JSON.stringify(m.toolResults)}`;
        }
        return {
          role: m.role === 'model' ? 'assistant' : 'user',
          content: text
        };
      })
    ];

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: promptMessages,
        max_tokens: 1024,
        temperature: 0.1
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Cloudflare Workers AI API error (${res.status}): ${errText}`);
    }

    const data: any = await res.json();
    const rawResponse = data.result?.response || '';

    // Parse JSON ReAct output
    try {
      const cleanJson = rawResponse.replace(/```json\s*/gi, '').replace(/```\s*$/gi, '').trim();
      const parsed = JSON.parse(cleanJson);

      if (parsed.tool) {
        const toolCalls: ToolCall[] = [
          {
            id: `cf_call_${Date.now()}`,
            name: parsed.tool,
            arguments: parsed.arguments || {}
          }
        ];
        return {
          thought: parsed.thought,
          toolCalls
        };
      }

      return {
        thought: parsed.thought,
        finalAnswer: parsed.finalAnswer || rawResponse
      };
    } catch {
      // Fallback if not valid JSON
      return {
        thought: 'Direct response generated',
        finalAnswer: rawResponse
      };
    }
  }

  async streamFinalAnswer(
    messages: Message[],
    systemInstruction: string,
    onToken: (token: string) => void
  ): Promise<{ fullText: string; tokensUsed: number }> {
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.modelName}`;

    const promptMessages = [
      { role: 'system', content: systemInstruction },
      ...messages.map((m) => ({
        role: m.role === 'model' ? 'assistant' : 'user',
        content: m.content
      }))
    ];

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: promptMessages,
        max_tokens: 2048,
        stream: true
      })
    });

    if (!res.ok || !res.body) {
      const errText = await res.text();
      throw new Error(`Cloudflare stream error: ${errText}`);
    }

    // Read SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ') && !line.includes('[DONE]')) {
          try {
            const parsed = JSON.parse(line.slice(6));
            const token = parsed.response || '';
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
