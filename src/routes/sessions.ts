import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/postgres.js';
import { verifyApiKey, verifyOriginShield } from '../security/auth.js';

export async function sessionRoutes(fastify: FastifyInstance) {
  fastify.get('/api/v1/sessions/:sessionId/history', {
    preHandler: [verifyOriginShield, verifyApiKey]
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { sessionId } = req.params as { sessionId: string };

    const sessionRes = await query(
      `SELECT id, tenant_id, title, metadata, created_at, updated_at
       FROM agent_sessions
       WHERE id = $1`,
      [sessionId]
    );

    if (sessionRes.rows.length === 0) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const messagesRes = await query(
      `SELECT id, role, content, tool_calls, tool_results, tokens_used, latency_ms, created_at
       FROM agent_messages
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [sessionId]
    );

    return reply.status(200).send({
      session: sessionRes.rows[0],
      messagesCount: messagesRes.rows.length,
      messages: messagesRes.rows
    });
  });

  fastify.delete('/api/v1/sessions/:sessionId', {
    preHandler: [verifyOriginShield, verifyApiKey]
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { sessionId } = req.params as { sessionId: string };

    await query('DELETE FROM agent_sessions WHERE id = $1', [sessionId]);

    return reply.status(200).send({
      success: true,
      message: `Session "${sessionId}" and associated messages deleted.`
    });
  });
}
