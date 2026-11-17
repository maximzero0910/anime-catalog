import assert from 'node:assert/strict';
import test from 'node:test';
import { readJsonBody } from '../request-body';

test('bounded JSON reader parses valid input under the byte ceiling', async () => {
  const request = new Request('https://anineko.test/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [1, 2] }) });
  assert.deepEqual(await readJsonBody(request, 128), { items: [1, 2] });
});

test('bounded JSON reader rejects declared and streamed oversized bodies', async () => {
  const declared = new Request('https://anineko.test/api', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1000' }, body: '{}' });
  await assert.rejects(readJsonBody(declared, 10), error => (error as { status?: number }).status === 413);
  const streamed = new Request('https://anineko.test/api', { method: 'POST', body: 'x'.repeat(30) });
  await assert.rejects(readJsonBody(streamed, 10), error => (error as { status?: number }).status === 413);
});

test('bounded JSON reader rejects malformed JSON safely', async () => {
  const request = new Request('https://anineko.test/api', { method: 'POST', body: '{' });
  await assert.rejects(readJsonBody(request, 10), /invalid JSON/);
});
