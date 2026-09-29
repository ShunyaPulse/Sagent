import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { query } from '../db/postgres.js';
import { getEmbeddingProvider } from '../providers/index.js';
import { verifyApiKey, verifyOriginShield } from '../security/auth.js';

const ingestSchema = z.object({
  title: z.string().min(1).max(255).default('Untitled Document'),
  content: z.string().min(5, 'Content must be at least 5 characters').max(50000, 'Content exceeds 50KB limit'),
  tenantId: z.string().default('default'),
  metadata: z.record(z.string(), z.any()).default({})
});

export async function knowledgeRoutes(fastify: FastifyInstance) {
  fastify.post('/api/v1/knowledge/ingest', {
    preHandler: [verifyOriginShield, verifyApiKey]
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const parseResult = ingestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        details: parseResult.error.format()
      });
    }

    const { title, content, tenantId, metadata } = parseResult.data;

    try {
      const embeddingProvider = getEmbeddingProvider();
      const embedding = await embeddingProvider.embed(content);
      const vectorString = `[${embedding.join(',')}]`;

      const insertRes = await query(
        `INSERT INTO agent_knowledge (tenant_id, title, content, embedding, metadata)
         VALUES ($1, $2, $3, $4::vector, $5)
         RETURNING id, title, created_at`,
        [tenantId, title, content, vectorString, JSON.stringify(metadata)]
      );

      return reply.status(201).send({
        success: true,
        document: insertRes.rows[0],
        dimensions: embedding.length,
        embeddingProvider: embeddingProvider.name
      });
    } catch (err: any) {
      console.error('Failed to ingest knowledge:', err);
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: err.message || 'Failed to generate embedding or store document in pgvector'
      });
    }
  });

  fastify.get('/api/v1/knowledge/search', {
    preHandler: [verifyOriginShield, verifyApiKey]
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const q = (req.query as any)?.q;
    const tenantId = (req.query as any)?.tenantId || 'default';
    const limit = Math.min(Number((req.query as any)?.limit) || 5, 20);

    if (!q || typeof q !== 'string') {
      return reply.status(400).send({ error: 'Query parameter "q" is required' });
    }

    try {
      const embeddingProvider = getEmbeddingProvider();
      const queryVector = await embeddingProvider.embed(q);
      const vectorString = `[${queryVector.join(',')}]`;

      const res = await query(
        `SELECT 
           id,
           title,
           content,
           metadata,
           1 - (embedding <=> $1::vector) AS similarity
         FROM agent_knowledge
         WHERE tenant_id = $2
         ORDER BY embedding <=> $1::vector ASC
         LIMIT $3`,
        [vectorString, tenantId, limit]
      );

      return reply.status(200).send({
        query: q,
        results: res.rows
      });
    } catch (err: any) {
      return reply.status(500).send({
        error: 'Search Failed',
        message: err.message
      });
    }
  });
}
