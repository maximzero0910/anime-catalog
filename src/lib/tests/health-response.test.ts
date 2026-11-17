import assert from 'node:assert/strict';
import test from 'node:test';
import { livenessResponse, readinessResponse } from '../health-response';

test('liveness is independent of optional external providers and does not cache', async () => {
  const response = livenessResponse();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'live' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('readiness reports only local dependency availability and fails closed', async () => {
  const ready = readinessResponse([() => undefined]);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: 'ready' });
  const unavailable = readinessResponse([() => { throw new Error('/srv/private/catalog.db unavailable'); }]);
  assert.equal(unavailable.status, 503);
  const body = await unavailable.json();
  assert.deepEqual(body, { status: 'not-ready' });
  assert.doesNotMatch(JSON.stringify(body), /private|catalog\.db/);
});
