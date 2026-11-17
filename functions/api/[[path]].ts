interface PagesProxyEnv {
  ANINEKO_API_ORIGIN?: string;
  ANINEKO_API_TIMEOUT_MS?: string;
  ANINEKO_RATE_LIMIT_SIGNING_SECRET?: string;
}

async function signClientAddress(secret: string | undefined, clientAddress: string | null): Promise<{ ip: string; timestamp: string; signature: string } | undefined> {
  if (!secret || new TextEncoder().encode(secret).byteLength < 32 || !clientAddress || clientAddress.length > 64 || /[\r\n,]/.test(clientAddress)) return undefined;
  const timestamp = String(Date.now());
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}\n${clientAddress}`)));
  const binary = Array.from(mac, byte => String.fromCharCode(byte)).join('');
  return { ip: clientAddress, timestamp, signature: btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') };
}

interface PagesProxyContext {
  request: Request;
  env: PagesProxyEnv;
}

// DECISION: Keep Pages static and forward its API paths to the Pi's Node server, where SQLite and background workers run.
export async function onRequest({ request, env }: PagesProxyContext): Promise<Response> {
  const configuredOrigin = env.ANINEKO_API_ORIGIN;
  if (!configuredOrigin) {
    return Response.json({ error: 'backend-unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  let backend: URL;
  try {
    backend = new URL(configuredOrigin);
  } catch {
    return Response.json({ error: 'backend-configuration-invalid' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  if (backend.protocol !== 'https:' || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash) {
    return Response.json({ error: 'backend-configuration-invalid' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }

  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, backend);
  const headers = new Headers(request.headers);
  headers.delete('host');
  // Never let user-supplied proxy identity headers survive the Pages-to-Pi hop.
  headers.delete('x-real-ip');
  headers.delete('x-anineko-client-ip');
  headers.delete('x-anineko-client-timestamp');
  headers.delete('x-anineko-client-signature');
  headers.delete('cf-connecting-ip');
  try {
    const signedClient = await signClientAddress(env.ANINEKO_RATE_LIMIT_SIGNING_SECRET, request.headers.get('cf-connecting-ip'));
    if (signedClient) {
      headers.set('x-anineko-client-ip', signedClient.ip);
      headers.set('x-anineko-client-timestamp', signedClient.timestamp);
      headers.set('x-anineko-client-signature', signedClient.signature);
    }
  } catch {
    // Rate limiting falls back to the socket peer when signing configuration is unavailable.
  }
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', incoming.protocol.slice(0, -1));

  const configuredTimeout = Number(env.ANINEKO_API_TIMEOUT_MS);
  const timeoutMs = Number.isSafeInteger(configuredTimeout) ? Math.min(60_000, Math.max(100, configuredTimeout)) : 20_000;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromClient = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) abortFromClient();
  else request.signal.addEventListener('abort', abortFromClient, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const upstreamRequest = new Request(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
      signal: controller.signal,
    });
    const upstream = await fetch(upstreamRequest);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  } catch {
    const status = request.signal.aborted ? 499 : timedOut ? 504 : 502;
    const error = request.signal.aborted ? 'request-cancelled' : timedOut ? 'backend-timeout' : 'backend-unreachable';
    return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abortFromClient);
  }
}
