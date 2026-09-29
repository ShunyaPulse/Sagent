import crypto from 'crypto';
import { z } from 'zod';
import { AgentTool } from '../core/types.js';
import { assertSafeUrl } from '../security/ssrf.js';
import { env } from '../config/env.js';

const webhookSchema = z.object({
  targetUrl: z
    .string()
    .transform((val) => {
      let trimmed = val.trim();
      if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        trimmed = 'https://' + trimmed;
      }
      return trimmed;
    })
    .pipe(z.string().url('Target webhook must be a valid HTTP or HTTPS URL')),
  payload: z.any().describe('JSON payload to transmit in webhook body'),
  event: z.string().default('agent.action.dispatched')
});

export const webhookDispatcherTool: AgentTool<typeof webhookSchema> = {
  name: 'webhook_dispatcher',
  description: 'Dispatches secure HTTP POST webhooks to external services or automation pipelines with HMAC-SHA256 signature verification.',
  parameters: webhookSchema,
  execute: async ({ targetUrl, payload, event }, context) => {
    // 1. SSRF Guard
    const safeUrl = await assertSafeUrl(targetUrl);

    // 2. Prepare payload and HMAC signature
    const timestamp = Date.now().toString();
    const bodyString = JSON.stringify({
      event,
      timestamp,
      sessionId: context.sessionId,
      data: payload
    });

    const hmac = crypto.createHmac('sha256', env.AUTH_SECRET);
    hmac.update(`${timestamp}.${bodyString}`);
    const signature = hmac.digest('hex');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const startTime = Date.now();

    try {
      const res = await fetch(safeUrl.toString(), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Sagent-Webhook-Dispatcher/1.0',
          'X-Sagent-Event': event,
          'X-Sagent-Timestamp': timestamp,
          'X-Sagent-Signature': signature
        },
        body: bodyString
      });

      const durationMs = Date.now() - startTime;
      const responseText = await res.text();

      let parsedResponse: any;
      try {
        parsedResponse = JSON.parse(responseText);
      } catch {
        parsedResponse = responseText.slice(0, 500);
      }

      return {
        success: res.ok,
        statusCode: res.status,
        durationMs,
        response: parsedResponse
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`Webhook dispatch timed out after 10 seconds to ${targetUrl}`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
};
