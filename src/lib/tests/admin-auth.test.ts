import assert from 'node:assert/strict';
import test from 'node:test';
import { adminAuthorized, adminTokenConfigured } from '../admin-auth';

const REQUEST_URL = 'http://127.0.0.1:4321/api/telegram/admin';
const requestWith = (headers: Record<string, string>) => new Request(REQUEST_URL, { headers });
const VALID_TOKEN = 'telegram-subtitles-admin-regression-token-0123456789abcdef';

test('adminTokenConfigured accepts only real token values', () => {
  assert.equal(adminTokenConfigured(undefined), false);
  assert.equal(adminTokenConfigured(''), false);
  assert.equal(adminTokenConfigured('   \t'), false);
  assert.equal(adminTokenConfigured('replace-with-a-long-random-secret'), false);
  assert.equal(adminTokenConfigured('replace-with-a-different-long-random-secret'), false);
  assert.equal(adminTokenConfigured('placeholder-value'), false);
  assert.equal(adminTokenConfigured(`  ${VALID_TOKEN}  `), true);
});

test('adminAuthorized denies every request when no token is configured', () => {
  const requests = [
    requestWith({}),
    requestWith({ authorization: 'Bearer anything' }),
    requestWith({ authorization: `Bearer ${VALID_TOKEN}` }),
    requestWith({ origin: 'https://anineko.eu', referer: 'https://anineko.eu/admin/telegram' }),
  ];
  for (const request of requests) {
    assert.equal(adminAuthorized(request, undefined), false);
    assert.equal(adminAuthorized(request, ''), false);
    assert.equal(adminAuthorized(request, '   '), false);
    assert.equal(adminAuthorized(request, 'replace-with-a-long-random-secret'), false);
  }
});

test('adminAuthorized requires an exact constant-time bearer match', () => {
  const expected = VALID_TOKEN;
  assert.equal(adminAuthorized(requestWith({}), expected), false);
  assert.equal(adminAuthorized(requestWith({ authorization: `Basic ${expected}` }), expected), false);
  assert.equal(adminAuthorized(requestWith({ authorization: expected }), expected), false);
  assert.equal(adminAuthorized(requestWith({ authorization: 'Bearer' }), expected), false);
  assert.equal(adminAuthorized(requestWith({ authorization: 'Bearer   ' }), expected), false);
  assert.equal(adminAuthorized(requestWith({ authorization: `Bearer ${'x'.repeat(expected.length)}` }), expected), false);
  assert.equal(adminAuthorized(requestWith({ authorization: `Bearer ${expected.slice(0, -1)}` }), expected), false);
  assert.equal(adminAuthorized(requestWith({ authorization: `Bearer ${expected}x` }), expected), false);
  assert.equal(adminAuthorized(requestWith({ authorization: `Bearer ${expected}` }), expected), true);
  assert.equal(adminAuthorized(requestWith({ authorization: `bearer ${expected}` }), expected), true);
  assert.equal(adminAuthorized(requestWith({ authorization: `  Bearer    ${expected}  ` }), expected), true);
});

test('adminAuthorized does not treat Origin or Referer as credentials', () => {
  const spoofed = requestWith({ origin: 'https://evil.example', referer: 'https://evil.example/admin', authorization: `Bearer ${VALID_TOKEN}` });
  assert.equal(adminAuthorized(spoofed, 'a-different-real-token'), false);
  assert.equal(adminAuthorized(spoofed, VALID_TOKEN), true);
});

interface AdminRoute { GET: (ctx: { request: Request }) => Promise<Response>; POST: (ctx: { request: Request }) => Promise<Response> }

async function withRouteEnv<T>(envName: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[envName];
  try {
    if (value === undefined) delete process.env[envName];
    else process.env[envName] = value;
    return await run();
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
}

const post = (url: string, headers: Record<string, string>, body: string) => new Request(url, { method: 'POST', headers, body });

async function assertUnauthorizedShape(response: Response, status: number): Promise<void> {
  assert.equal(response.status, status);
  const payload = await response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ['error']);
  assert.equal(typeof payload.error, 'string');
}

for (const routeCase of [
  { name: 'telegram admin', url: 'http://127.0.0.1:4321/api/telegram/admin', env: 'TELEGRAM_ADMIN_TOKEN', module: '../../pages/api/telegram/admin' },
  { name: 'subtitles admin', url: 'http://127.0.0.1:4321/api/subtitles/admin', env: 'SUBTITLE_ADMIN_TOKEN', module: '../../pages/api/subtitles/admin' },
]) {
  test(`${routeCase.name} route rejects every unauthenticated request`, async () => {
    const route = await import(routeCase.module) as AdminRoute;
    await withRouteEnv(routeCase.env, VALID_TOKEN, async () => {
      await assertUnauthorizedShape(await route.GET({ request: new Request(routeCase.url) }), 401);
      await assertUnauthorizedShape(await route.GET({ request: requestWith({ authorization: 'Bearer wrong-token' }) }), 401);
      await assertUnauthorizedShape(await route.GET({ request: requestWith({ authorization: 'Basic abc' }) }), 401);
      await assertUnauthorizedShape(await route.POST({ request: post(routeCase.url, { 'content-type': 'application/json' }, '{"action":"sync"}') }), 401);
      await assertUnauthorizedShape(await route.POST({ request: post(routeCase.url, { 'content-type': 'application/json', authorization: `Bearer ${'z'.repeat(VALID_TOKEN.length)}` }, '{"action":"sync"}') }), 401);
    });
  });

  test(`${routeCase.name} route serves authorized requests and gates the dispatcher`, async () => {
    const route = await import(routeCase.module) as AdminRoute;
    await withRouteEnv(routeCase.env, VALID_TOKEN, async () => {
      const authorizedHeaders = { authorization: `Bearer ${VALID_TOKEN}` };
      const read = await route.GET({ request: new Request(routeCase.url, { headers: authorizedHeaders }) });
      assert.equal(read.status, 200);
      const payload = await read.json() as Record<string, unknown>;
      assert.ok(typeof payload === 'object' && payload !== null);
      const dispatched = await route.POST({ request: post(routeCase.url, { ...authorizedHeaders, 'content-type': 'application/json' }, '{"action":"definitely-not-a-real-action"}') });
      assert.equal(dispatched.status, 400);
      assert.equal((await dispatched.json() as { error: string }).error, 'unknown-action');
    });
  });

  test(`${routeCase.name} route denies all requests when the token is not configured`, async () => {
    const route = await import(routeCase.module) as AdminRoute;
    for (const unconfigured of [undefined, '', '   ', 'replace-with-a-long-random-secret']) {
      await withRouteEnv(routeCase.env, unconfigured, async () => {
        await assertUnauthorizedShape(await route.GET({ request: requestWith({ authorization: `Bearer ${VALID_TOKEN}` }) }), 503);
        await assertUnauthorizedShape(await route.POST({ request: post(routeCase.url, { 'content-type': 'application/json', authorization: `Bearer ${VALID_TOKEN}` }, '{"action":"sync"}') }), 503);
      });
    }
  });
}
