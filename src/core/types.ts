import { z } from 'zod';

export type Role = 'user' | 'model' | 'system' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  output: any;
  isError?: boolean;
  durationMs: number;
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface AgentContext {
  sessionId: string;
  tenantId: string;
  userIp?: string;
  metadata?: Record<string, any>;
}

export type AgentStreamEvent =
  | { type: 'thought'; step: number; thought: string }
  | { type: 'tool_call'; tool: string; args: Record<string, any>; callId: string }
  | { type: 'tool_result'; tool: string; result: any; durationMs: number; isError?: boolean }
  | { type: 'token'; text: string }
  | { type: 'done'; sessionId: string; totalTokens: number; latencyMs: number }
  | { type: 'error'; message: string };

export interface AgentTool<TParams extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: TParams;
  execute: (args: z.infer<TParams>, context: AgentContext) => Promise<any>;
}

export interface StepOutput {
  thought?: string;
  toolCalls?: ToolCall[];
  finalAnswer?: string;
  tokensUsed?: number;
}

export interface LLMProvider {
  name: string;
  generateStep(
    messages: Message[],
    tools: AgentTool[],
    systemInstruction: string
  ): Promise<StepOutput>;
  
  streamFinalAnswer(
    messages: Message[],
    systemInstruction: string,
    onToken: (token: string) => void
  ): Promise<{ fullText: string; tokensUsed: number }>;
}

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(text: string): Promise<number[]>;
}
