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
  private static inMemorySessions = new Map<string, Message[]>();

  constructor(registry?: ToolRegistry) {
    this.registry = registry || new ToolRegistry();
  }

  async run(options: ExecuteOptions): Promise<{
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
      // 1. Ensure Session exists in PostgreSQL if configured
      if (env.DATABASE_URL) {
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
      }

      // 2. Fetch Short-Term Memory (Last 10 messages for conversation context)
      let messages: Message[] = [];
      if (env.DATABASE_URL) {
        const historyRows = await query(
          `SELECT role, content, tool_calls, tool_results
           FROM agent_messages
           WHERE session_id = $1
           ORDER BY created_at DESC
           LIMIT 10`,
          [context.sessionId],
        );
        messages = [...historyRows.rows].reverse().map((row) => ({
          role: row.role,
          content: row.content,
        }));
      } else {
        const mem = AgentEngine.inMemorySessions.get(context.sessionId) || [];
        messages = [...mem.slice(-10)];
      }

      // Append current user message with injection defense delimiters
      const formattedInput = formatUserMessageWithDelimiters(userMessage);
      messages.push({
        role: "user",
        content: formattedInput,
      });

      // Save user message to database or in-memory session
      if (env.DATABASE_URL) {
        await query(
          `INSERT INTO agent_messages (session_id, role, content)
           VALUES ($1, 'user', $2)`,
          [context.sessionId, userMessage],
        );
      } else {
        const mem = AgentEngine.inMemorySessions.get(context.sessionId) || [];
        mem.push({ role: "user", content: userMessage });
        AgentEngine.inMemorySessions.set(context.sessionId, mem);
      }

      let finalAnswer: string | undefined;
      const allToolCallsExecuted: any[] = [];
      const allToolResultsRecorded: ToolResult[] = [];
      const writtenPathsInRun = new Set<string>();
      const failedCallsCount = new Map<string, number>();

      // 3. ReAct Execution Loop (Step-by-step reasoning & action)
      while (stepsExecuted < env.MAX_REACT_STEPS) {
        stepsExecuted++;

        // Call active LLM Provider
        const systemPromptWithContext = context.activeFile
          ? `${AGENT_SYSTEM_PROMPT}\n\n[Active Workspace Context: Currently active file is "${context.activeFile}". If the user asks to modify, replace, or read text without mentioning a file, target this file.]`
          : AGENT_SYSTEM_PROMPT;

        const step = await provider.generateStep(
          messages,
          this.registry.getAll(),
          systemPromptWithContext,
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
            const callSig = `${tc.name}:${JSON.stringify(tc.arguments || {})}`;
            const failCount = failedCallsCount.get(callSig) || 0;

            if (failCount >= 2) {
              finalAnswer = `Execution stopped: The tool call "${tc.name}" failed repeatedly with identical arguments. Please inspect the workspace or verify that the target file and content exist.`;
              break;
            }

            allToolCallsExecuted.push(tc);

            emit({
              type: "tool_call",
              tool: tc.name,
              args: tc.arguments,
              callId: tc.id,
            });

            // Prevent repetitive file_writer loop on the same file
            if (tc.name === "file_writer") {
              const targetPath = tc.arguments?.path;
              const isAppend = Boolean(tc.arguments?.append);
              if (
                targetPath &&
                writtenPathsInRun.has(targetPath) &&
                !isAppend
              ) {
                finalAnswer = `I have successfully created and saved "${targetPath}".`;
                break;
              }
              if (targetPath) {
                writtenPathsInRun.add(targetPath);
              }
            }

            // Prevent repetitive file_patcher loop on the same file once patched
            if (tc.name === "file_patcher") {
              const targetPath = tc.arguments?.path;
              if (targetPath && writtenPathsInRun.has(`patched:${targetPath}`)) {
                finalAnswer = `I have successfully updated "${targetPath}".`;
                break;
              }
            }

            // Execute through tool registry with self-correction & audit logging
            const result = await this.registry.executeTool(
              tc.name,
              tc.id,
              tc.arguments,
              context,
            );

            if (result.isError) {
              failedCallsCount.set(callSig, failCount + 1);
            } else if (tc.name === "file_patcher" && tc.arguments?.path) {
              writtenPathsInRun.add(`patched:${tc.arguments.path}`);
            }

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

          if (finalAnswer) {
            emit({
              type: "token",
              text: finalAnswer,
            });
            break;
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

        // If no tool calls, check if candidate answer falsely claims a file action occurred without executing any tool
        const candidateAnswer =
          step.finalAnswer ||
          (step.thought && !step.toolCalls ? step.thought : "");
        const isActionRequest =
          /\b(?:replace|create|modify|write|patch|update|change|delete|remove|append)\b/i.test(
            userMessage,
          );
        const claimsFileActionDone =
          /(?:has been modified|has been created|has been updated|successfully replaced|successfully modified|successfully created|Action is complete)/i.test(
            candidateAnswer,
          );

        if (
          allToolCallsExecuted.length === 0 &&
          isActionRequest &&
          claimsFileActionDone &&
          stepsExecuted < env.MAX_REACT_STEPS
        ) {
          const targetHint = context.activeFile
            ? ` on active file "${context.activeFile}"`
            : "";
          messages.push({
            role: "user",
            content: `CRITICAL: You stated that the action is complete or file has been modified/created, but you did NOT call any tools! You CANNOT modify files through text alone. You MUST call "file_patcher" or "file_writer" now with the exact parameters to perform the requested change${targetHint}.`,
          });
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

      let finalAnswerStr =
        typeof finalAnswer === "string"
          ? finalAnswer
          : typeof (finalAnswer as any)?.finalAnswer === "string"
            ? (finalAnswer as any).finalAnswer
            : JSON.stringify(finalAnswer, null, 2);

      // Defensively unpack any raw JSON strings containing finalAnswer or thoughts
      if (
        typeof finalAnswerStr === "string" &&
        finalAnswerStr.trim().startsWith("{")
      ) {
        try {
          const parsed = JSON.parse(finalAnswerStr.trim());
          if (parsed.finalAnswer && typeof parsed.finalAnswer === "string") {
            finalAnswerStr = parsed.finalAnswer;
          }
        } catch {
          const match = finalAnswerStr.match(
            /"finalAnswer"\s*:\s*"([\s\S]*?)"\s*\}/,
          );
          if (match && match[1]) {
            finalAnswerStr = match[1]
              .replace(/\\n/g, "\n")
              .replace(/\\"/g, '"');
          }
        }
      }

      // If the answer contains "Final Answer:", isolate only the real answer intended for the user
      if (/Final Answer\s*:\s*/i.test(finalAnswerStr)) {
        const parts = finalAnswerStr.split(/Final Answer\s*:\s*/i);
        finalAnswerStr = parts[parts.length - 1].trim();
      }

      // Clean up internal thoughts if leaked into final answer
      finalAnswerStr = finalAnswerStr
        .replace(/(?:^|\n+)Thought\s*:\s*[\s\S]*?(?=\n\n|\n[A-Z]|$)/gi, "")
        .replace(/\bThought:\s*[\s\S]*$/i, "")
        .trim();

      // Convert literal \n to real newlines if string has unescaped escaped newlines
      if (finalAnswerStr.includes("\\n") && !finalAnswerStr.includes("\n")) {
        finalAnswerStr = finalAnswerStr.replace(/\\n/g, "\n");
      }

      // Guard against false permission refusal hallucinations when file operations succeeded
      const successfulFileOps = allToolResultsRecorded.filter(
        (r) =>
          (r.name === "file_writer" ||
            r.name === "file_patcher" ||
            r.name === "file_editor") &&
          !r.isError &&
          (r.output as any)?.success === true,
      );

      if (
        successfulFileOps.length > 0 &&
        /(?:permission error|cannot be created|will not attempt to write|cannot be modified)/i.test(
          finalAnswerStr,
        )
      ) {
        const lastOp = successfulFileOps[successfulFileOps.length - 1];
        const filePath = (lastOp.output as any)?.path || "file";
        if (lastOp.name === "file_writer") {
          finalAnswerStr = `I have successfully created and saved \`${filePath}\`.`;
        } else {
          finalAnswerStr = `I have successfully updated \`${filePath}\`.`;
        }
      }

      // If no tools were executed but final answer claims file was modified/created, override hallucination
      if (
        allToolCallsExecuted.length === 0 &&
        /\b(?:replace|create|modify|write|patch|update|change|delete|remove|append)\b/i.test(
          userMessage,
        ) &&
        /(?:has been modified|has been created|has been updated|successfully replaced|successfully modified|successfully created|Action is complete)/i.test(
          finalAnswerStr,
        )
      ) {
        finalAnswerStr = `Unable to modify file: no tools were executed. Please specify the target file name explicitly (e.g., 'replace X with Y in ${context.activeFile || "filename"}').`;
      }

      // Ensure clean paragraph separation after bold headers at the start of lines without breaking mid-sentence bold items
      finalAnswerStr = finalAnswerStr.replace(
        /^(\*\*[^\*\n]+?\*\*)([A-Za-z0-9])/gm,
        "$1\n\n$2",
      );

      // Ensure bulleted list items have clean newlines and proper spacing (safely ignoring bold syntax '**')
      finalAnswerStr = finalAnswerStr
        .replace(/([^\n])\s*(?<!\*)[*-](?!\*)\s+/g, "$1\n- ")
        .replace(/([^\n])\s*(?<!\*)[*-](?!\*)\s*(`)/g, "$1\n- $2");

      // Stream the answer tokens to the client
      const chunks = finalAnswerStr.match(/[\s\S]{1,16}/g) || [finalAnswerStr];
      for (const chunk of chunks) {
        emit({ type: "token", text: chunk });
      }

      const totalLatency = Date.now() - startTime;

      // 5. Persist Assistant Response & Metrics to Neon DB or in-memory session
      if (env.DATABASE_URL) {
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
      } else {
        const mem = AgentEngine.inMemorySessions.get(context.sessionId) || [];
        mem.push({ role: "model", content: finalAnswerStr });
        AgentEngine.inMemorySessions.set(context.sessionId, mem);
      }

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
