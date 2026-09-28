import crypto from 'crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';

/**
 * Constant-time string equality check to prevent side-channel timing attacks.
 */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Constant-time dummy comparison to prevent length leak
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Fastify Pre-handler Hook: Verifies Origin Shielding Secret (x-origin-secret)
 * Ensures traffic came exclusively through Cloudflare edge worker.
 */
export async function verifyOriginShield(req: FastifyRequest, reply: FastifyReply) {
  if (!env.ENABLE_ORIGIN_SHIELDING) {
    return;
  }

  const originSecretHeader = req.headers['x-origin-secret'] as string | undefined;

  if (!originSecretHeader || !safeEqual(originSecretHeader, env.ORIGIN_SECRET)) {
    reply.status(403).send({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Origin Shield Verification Failed. Direct unauthenticated ingress is prohibited.'
    });
    return reply;
  }
}

/**
 * Fastify Pre-handler Hook: Verifies Client API Key (Authorization: Bearer <KEY>)
 */
export async function verifyApiKey(req: FastifyRequest, reply: FastifyReply) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Missing or malformed Authorization header. Expected Bearer token.'
    });
    return reply;
  }

  const token = authHeader.slice(7).trim();

  if (!safeEqual(token, env.AUTH_SECRET)) {
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid API Key provided.'
    });
    return reply;
  }
}

/**
 * Verifies Cloudflare Turnstile token if passed in request header 'x-turnstile-token'
 */
export async function verifyTurnstileToken(token: string, remoteIp?: string): Promise<boolean> {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!secretKey) {
    return true; // Turnstile secret not configured, bypass
  }

  try {
    const formData = new URLSearchParams();
    formData.append('secret', secretKey);
    formData.append('response', token);
    if (remoteIp) {
      formData.append('remoteip', remoteIp);
    }

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      headers: {
        'content-type': 'application/x-www-form-urlencoded'
      }
    });

    const outcome: any = await res.json();
    return outcome.success === true;
  } catch (err) {
    console.error('Turnstile verification error:', err);
    return false;
  }
}
