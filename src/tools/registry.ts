import { AgentTool, AgentContext, ToolResult } from '../core/types.js';
import { httpFetcherTool } from './http-fetcher.js';
import { sqlVectorSearchTool } from './sql-vector-search.js';
import { webhookDispatcherTool } from './webhook-dispatcher.js';
import { dataCalculatorTool } from './data-calculator.js';
import { query } from '../db/postgres.js';

export class ToolRegistry {
  private tools: Map<string, AgentTool<any>> = new Map();

  constructor() {
    this.register(httpFetcherTool);
    this.register(sqlVectorSearchTool);
    this.register(webhookDispatcherTool);
    this.register(dataCalculatorTool);
  }

  register(tool: AgentTool<any>) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool<any> | undefined {
    return this.tools.get(name);
  }

  getAll(): AgentTool<any>[] {
    return Array.from(this.tools.values());
  }

  async executeTool(
    toolName: string,
    toolCallId: string,
    rawArgs: Record<string, any>,
    context: AgentContext
  ): Promise<ToolResult> {
    const tool = this.get(toolName);
    const start = Date.now();

    if (!tool) {
      return {
        toolCallId,
        name: toolName,
        output: { error: `Tool "${toolName}" is not registered in the system.` },
        isError: true,
        durationMs: Date.now() - start
      };
    }

    try {
      const parsedArgs = tool.parameters.parse(rawArgs);
      const output = await tool.execute(parsedArgs, context);
      const durationMs = Date.now() - start;

      this.recordAuditLog(context.sessionId, toolName, parsedArgs, output, 'success', context.userIp, durationMs);

      return {
        toolCallId,
        name: toolName,
        output,
        isError: false,
        durationMs
      };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const errorMessage = err.message || 'Tool execution encountered an unknown error';

      this.recordAuditLog(context.sessionId, toolName, rawArgs, { error: errorMessage }, 'failed', context.userIp, durationMs);

      return {
        toolCallId,
        name: toolName,
        output: {
          error: errorMessage,
          hint: 'Analyze the error above, correct the input parameters, and retry or inform the user.'
        },
        isError: true,
        durationMs
      };
    }
  }

  private recordAuditLog(
    sessionId: string,
    toolName: string,
    input: any,
    output: any,
    status: string,
    ip?: string,
    durationMs?: number
  ) {
    query(
      `INSERT INTO agent_audit_logs (session_id, action, tool_name, input_payload, output_payload, status, ip_address, execution_time_ms)
       VALUES ($1, 'tool_execution', $2, $3, $4, $5, $6, $7)`,
      [sessionId, toolName, JSON.stringify(input), JSON.stringify(output), status, ip || null, durationMs || 0]
    ).catch((err) => {
      console.warn('⚠️ Failed to write audit log to PostgreSQL:', err.message);
    });
  }
}
