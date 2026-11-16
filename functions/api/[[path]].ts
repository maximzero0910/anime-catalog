interface PagesProxyEnv {
  ANINEKO_API_ORIGIN?: string;
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
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', incoming.protocol.slice(0, -1));

  try {
    const upstreamRequest = new Request(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    });
    const upstream = await fetch(upstreamRequest);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  } catch {
    return Response.json({ error: 'backend-unreachable' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}
