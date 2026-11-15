import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import test from 'node:test';
import { decryptEmbed, packedUrls, serverIds } from '../nineanime';

function encryptedUrl(value: string, passphrase: string): string {
  const salt = Buffer.from('0102030405060708', 'hex');
  const derived: Buffer[] = [];
  let prior = Buffer.alloc(0);
  while (Buffer.concat(derived).length < 48) {
    prior = createHash('md5').update(Buffer.concat([prior, Buffer.from(passphrase), salt])).digest();
    derived.push(prior);
  }
  const keyIv = Buffer.concat(derived);
  const cipher = createCipheriv('aes-256-cbc', keyIv.subarray(0, 32), keyIv.subarray(32, 48));
  const body = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__'), salt, body]).toString('base64');
}

test('9anime decrypt tries passphrases and decrypts AES-CBC base64 server URL', () => {
  const encrypted = encryptedUrl('https://kwik.si/e/episode', 'nen');
  assert.equal(decryptEmbed(encrypted), 'https://kwik.si/e/episode');
});

test('9anime server selection keeps sub and dub lists separate with attribute order variations', () => {
  const html = '<div id="servers-sub"><button data-id="s1" class="server"></button></div><div id="servers-dub"><button class="server" data-id="d1"></button></div>';
  assert.deepEqual(serverIds(html, 'sub'), ['s1']);
  assert.deepEqual(serverIds(html, 'dub'), ['d1']);
});

test('Kwik packed player extraction runs in the VM and captures configured HLS URLs', async () => {
  const script = 'jwplayer("player").setup({file:"https://stream.example/live.m3u8"})';
  assert.deepEqual(await packedUrls(script, 'https://kwik.si/e/episode'), ['https://stream.example/live.m3u8']);
});
