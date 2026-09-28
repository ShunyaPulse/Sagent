import {
  Message,
  AgentContext,
  AgentStreamEvent,
  ToolResult,
  LLMProvider,
} from "./types.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  AGENT_SYSTEM_PROMPT,
  formatUserMessageWithDelimiters,
} from "./prompts.js";
import { query } from "../db/postgres.js";
import { env } from "../config/env.js";

export interface ExecuteOptions {
  context: AgentContext;
  userMessage: string;
  provider: LLMProvider;
  onEvent?: (event: AgentStreamEvent) => void;
}

export class AgentEngine {
  private registry: ToolRegistry;

  constructor(registry?: ToolRegistry) {
    this.registry = registry || new ToolRegistry();
  }

  async run(
    options: ExecuteOptions,
  ): Promise<{
    finalAnswer: string;
    totalTokens: number;
    stepsExecuted: number;
  }> {
    const { context, userMessage, provider, onEvent } = options;
    const startTime = Date.now();
    let totalTokens = 0;
    let stepsExecuted = 0;

    const emit = (event: AgentStreamEvent) => {
      if (onEvent) {
        onEvent(event);
      }
    };

    try {
      // 1. Ensure Session exists in PostgreSQL
      await query(
        `INSERT INTO agent_sessions (id, tenant_id, title)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
        [
          context.sessionId,
          context.tenantId || "default",
          userMessage.slice(0, 50),
        ],
      );

      // 2. Fetch Short-Term Memory (Last 10 messages for conversation context)
      const historyRows = await query(
        `SELECT role, content, tool_calls, tool_results
         FROM agent_messages
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [context.sessionId],
      );

      // Reconstruct chronological message history
      const messages: Message[] = historyRows.rows.reverse().map((row) => ({
        role: row.role,
        content: row.content,
        toolCalls: row.tool_calls,
        toolResults: row.tool_results,
      }));

      // Append current user message with injection defense delimiters
      const formattedInput = formatUserMessageWithDelimiters(userMessage);
      messages.push({
        role: "user",
        content: formattedInput,
      });

      // Save user message to database
      await query(
        `INSERT INTO agent_messages (session_id, role, content)
         VALUES ($1, 'user', $2)`,
        [context.sessionId, userMessage],
      );

      let finalAnswer: string | undefined;
      const allToolCallsExecuted: any[] = [];
      const allToolResultsRecorded: ToolResult[] = [];

      // 3. ReAct Execution Loop (Step-by-step reasoning & action)
      while (stepsExecuted < env.MAX_REACT_STEPS) {
        stepsExecuted++;

        // Call active LLM Provider
        const step = await provider.generateStep(
          messages,
          this.registry.getAll(),
          AGENT_SYSTEM_PROMPT,
        );

        if (step.tokensUsed) {
          totalTokens += step.tokensUsed;
        }

        // Emit Thought Event
        if (step.thought) {
          emit({
            type: "thought",
            step: stepsExecuted,
            thought: step.thought,
          });
        }

        // Check if model wants to execute tools
        if (step.toolCalls && step.toolCalls.length > 0) {
          // Model decided to take action
          messages.push({
            role: "model",
            content: step.thought || "",
            toolCalls: step.toolCalls,
          });

          const currentStepResults: ToolResult[] = [];

          for (const tc of step.toolCalls) {
            allToolCallsExecuted.push(tc);

            emit({
              type: "tool_call",
              tool: tc.name,
              args: tc.arguments,
              callId: tc.id,
            });

            // Execute through tool registry with self-correction & audit logging
            const result = await this.registry.executeTool(
              tc.name,
              tc.id,
              tc.arguments,
              context,
            );

            currentStepResults.push(result);
            allToolResultsRecorded.push(result);

            emit({
              type: "tool_result",
              tool: tc.name,
              result: result.output,
              durationMs: result.durationMs,
              isError: result.isError,
            });
          }

          // Feed tool observations back into the message history for the next reasoning step
          messages.push({
            role: "tool",
            content: "",
            toolResults: currentStepResults,
          });

          // Continue to next turn in ReAct loop
          continue;
        }

        // If no tool calls, model has reached a final answer
        if (step.finalAnswer) {
          finalAnswer = step.finalAnswer;
          break;
        }

        // Fallback: If thought is present without tool calls or answer, treat thought as answer
        if (step.thought && !step.toolCalls) {
          finalAnswer = step.thought;
          break;
        }
      }

      // 4. Circuit Breaker Fallback if max steps reached
      if (!finalAnswer) {
        finalAnswer = `I have analyzed the query through ${stepsExecuted} reasoning steps. Based on the gathered data: ${
          allToolResultsRecorded.length > 0
            ? "Tools executed successfully, but reached maximum reasoning depth limit."
            : "Unable to reach a definitive conclusion within the allocated step budget."
        }`;
      }

      const finalAnswerStr =
        typeof finalAnswer === "string"
          ? finalAnswer
          : typeof (finalAnswer as any)?.finalAnswer === "string"
            ? (finalAnswer as any).finalAnswer
            : JSON.stringify(finalAnswer, null, 2);

      // Stream the answer tokens to the client
      const chunks = finalAnswerStr.match(/.{1,12}/g) || [finalAnswerStr];
      for (const chunk of chunks) {
        emit({ type: "token", text: chunk });
      }

      const totalLatency = Date.now() - startTime;

      // 5. Persist Assistant Response & Metrics to Neon DB
      await query(
        `INSERT INTO agent_messages (session_id, role, content, tool_calls, tool_results, tokens_used, latency_ms)
         VALUES ($1, 'model', $2, $3, $4, $5, $6)`,
        [
          context.sessionId,
          finalAnswerStr,
          JSON.stringify(allToolCallsExecuted),
          JSON.stringify(allToolResultsRecorded),
          totalTokens,
          totalLatency,
        ],
      );

      emit({
        type: "done",
        sessionId: context.sessionId,
        totalTokens,
        latencyMs: totalLatency,
      });

      return {
        finalAnswer,
        totalTokens,
        stepsExecuted,
      };
    } catch (err: any) {
      console.error("❌ Agent Engine Execution Failure:", err);
      emit({
        type: "error",
        message: err.message || "Internal agent execution error",
      });
      throw err;
    }
  }
}
