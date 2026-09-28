import { FastifyInstance } from 'fastify';
import { checkDbHealth } from '../db/postgres.js';
import { checkRedisHealth } from '../db/redis.js';

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/healthz', async (_req, reply) => {
    return reply.status(200).send({
      status: 'ok',
      service: 'sagent',
      timestamp: new Date().toISOString()
    });
  });

  fastify.get('/readyz', async (_req, reply) => {
    const [dbHealthy, redisHealthy] = await Promise.all([
      checkDbHealth(),
      checkRedisHealth()
    ]);

    const isReady = dbHealthy;

    return reply.status(isReady ? 200 : 503).send({
      status: isReady ? 'ready' : 'degraded',
      dependencies: {
        neonPostgres: dbHealthy ? 'connected' : 'unreachable',
        redis: redisHealthy ? 'connected' : 'fallback_mode'
      },
      timestamp: new Date().toISOString()
    });
  });
}
