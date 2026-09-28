export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-turnstile-token',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    if (request.method === 'POST') {
      const turnstileToken = request.headers.get('x-turnstile-token');

      if (env.ENFORCE_TURNSTILE === 'true') {
        if (!turnstileToken) {
          return new Response(
            JSON.stringify({
              error: 'Forbidden',
              message: 'Missing required x-turnstile-token header at Cloudflare edge.'
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } }
          );
        }

        const formData = new URLSearchParams();
        formData.append('secret', env.TURNSTILE_SECRET_KEY);
        formData.append('response', turnstileToken);
        formData.append('remoteip', request.headers.get('CF-Connecting-IP') || '');

        const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          body: formData,
          headers: { 'content-type': 'application/x-www-form-urlencoded' }
        });

        const outcome = await verifyRes.json();
        if (!outcome.success) {
          return new Response(
            JSON.stringify({
              error: 'Forbidden',
              message: 'Turnstile verification failed. Request dropped at edge.'
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
    }

    const originUrl = new URL(url.pathname + url.search, env.CLOUD_RUN_ORIGIN_URL);
    const newHeaders = new Headers(request.headers);
    newHeaders.set('x-origin-secret', env.ORIGIN_SECRET);

    const forwardRequest = new Request(originUrl.toString(), {
      method: request.method,
      headers: newHeaders,
      body: request.body,
      redirect: 'follow'
    });

    return await fetch(forwardRequest);
  }
};
