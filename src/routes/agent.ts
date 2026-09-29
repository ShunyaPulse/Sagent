import crypto from "crypto";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { AgentEngine } from "../core/engine.js";
import { getLLMProvider } from "../providers/index.js";
import { acquireSessionLock, releaseSessionLock } from "../db/redis.js";
import {
  verifyApiKey,
  verifyOriginShield,
  verifyTurnstileToken,
} from "../security/auth.js";
import { AgentStreamEvent } from "../core/types.js";

const chatRequestSchema = z.object({
  sessionId: z
    .string()
    .default(
      () => `session_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    ),
  tenantId: z.string().default("default"),
  message: z
    .string()
    .min(1, "Message cannot be empty")
    .max(10000, "Message exceeds 10KB limit"),
  stream: z.boolean().default(true),
  modelProvider: z.enum(["model-first", "gemini", "cloudflare"]).optional(),
  turnstileToken: z.string().optional(),
});

export async function agentRoutes(fastify: FastifyInstance) {
  const engine = new AgentEngine();

  fastify.post(
    "/api/v1/agent/chat",
    {
      preHandler: [verifyOriginShield, verifyApiKey],
      schema: {
        body: {
          type: "object",
          required: ["message"],
          properties: {
            sessionId: { type: "string" },
            tenantId: { type: "string" },
            message: { type: "string" },
            stream: { type: "boolean" },
            modelProvider: {
              type: "string",
              enum: ["model-first", "gemini", "cloudflare"],
            },
            turnstileToken: { type: "string" },
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parseResult = chatRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: "Bad Request",
          details: parseResult.error.format(),
        });
      }

      const {
        sessionId,
        tenantId,
        message,
        stream,
        modelProvider,
        turnstileToken,
      } = parseResult.data;

      const tokenToCheck =
        turnstileToken || (req.headers["x-turnstile-token"] as string);
      if (tokenToCheck) {
        const isTurnstileValid = await verifyTurnstileToken(
          tokenToCheck,
          req.ip,
        );
        if (!isTurnstileValid) {
          return reply.status(403).send({
            statusCode: 403,
            error: "Forbidden",
            message:
              "Cloudflare Turnstile token validation failed. Bot detection triggered.",
          });
        }
      }

      const lockToken = await acquireSessionLock(sessionId, 45);
      if (!lockToken) {
        return reply.status(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: `Session "${sessionId}" is currently processing an active ReAct loop. Please wait for completion.`,
        });
      }

      const provider = getLLMProvider(modelProvider);
      const context = {
        sessionId,
        tenantId,
        userIp: req.ip,
      };

      try {
        if (stream) {
          reply.hijack();
          reply.raw.setHeader(
            "Content-Type",
            "text/event-stream; charset=utf-8",
          );
          reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
          reply.raw.setHeader("Connection", "keep-alive");
          reply.raw.setHeader("X-Accel-Buffering", "no");
          reply.raw.flushHeaders?.();

          const sendEvent = (event: AgentStreamEvent) => {
            const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
            reply.raw.write(payload);
          };

          await engine.run({
            context,
            userMessage: message,
            provider,
            onEvent: sendEvent,
          });

          reply.raw.end();
          return;
        } else {
          const eventsRecorded: AgentStreamEvent[] = [];
          const result = await engine.run({
            context,
            userMessage: message,
            provider,
            onEvent: (evt) => eventsRecorded.push(evt),
          });

          return reply.status(200).send({
            sessionId,
            tenantId,
            finalAnswer: result.finalAnswer,
            totalTokens: result.totalTokens,
            stepsExecuted: result.stepsExecuted,
            trace: eventsRecorded,
          });
        }
      } catch (err: any) {
        if (stream) {
          reply.raw.write(
            `event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`,
          );
          reply.raw.end();
          return reply;
        }
        return reply.status(500).send({
          statusCode: 500,
          error: "Internal Server Error",
          message: err.message || "Agent failed to complete execution.",
        });
      } finally {
        await releaseSessionLock(sessionId, lockToken);
      }
    },
  );
}
