import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { httpGet } from '../types';

test('httpGet HEAD returns representation headers without buffering advertised media bytes', async () => {
  const previousDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent.get('https://media.example')
    .intercept({ path: '/episode.mp4', method: 'HEAD' })
    .reply(200, '', {
      headers: {
        'content-length': String(64 * 1024 * 1024),
        'content-type': 'video/mp4',
      },
    });
  setGlobalDispatcher(mockAgent);
  try {
    const response = await httpGet('https://media.example/episode.mp4', {
      provider: 'playtube',
      method: 'HEAD',
      retries: 0,
    });
    assert.equal(response.status, 200);
    assert.equal(response.text, '');
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(response.headers.get('content-length'), String(64 * 1024 * 1024));
  } finally {
    setGlobalDispatcher(previousDispatcher);
    await mockAgent.close();
  }
});
