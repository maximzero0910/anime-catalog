export function readinessResponse(checks: Array<() => void>): Response {
  try {
    for (const check of checks) check();
    return Response.json({ status: 'ready' }, { status: 200, headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ status: 'not-ready' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}

export function livenessResponse(): Response {
  return Response.json({ status: 'live' }, { status: 200, headers: { 'cache-control': 'no-store' } });
}
