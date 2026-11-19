import { authorizeKaggleWorker } from './kaggle-worker';
export async function workerJson<T>(request: Request, maxBytes = 9 * 1024 * 1024): Promise<T> {
  if (!authorizeKaggleWorker(request)) throw new Response('unauthorized', { status: 401, headers: { 'cache-control': 'no-store' } });
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) throw new Response('application/json required', { status: 415 });
  const contentLength=request.headers.get('content-length');
  const length=contentLength===null?null:Number(contentLength);
  if(length!==null&&(!Number.isSafeInteger(length)||length<0)) throw new Response('invalid content length',{status:400});
  if (length !== null && length > maxBytes) throw new Response('request too large', { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) throw new Response('request body required', { status: 400 });
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (length===null||size<length) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new Response('request too large', { status: 413 }); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  if(length!==null&&size!==length) throw new Response('request body length mismatch',{status:400});
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as T; }
  catch (error) { if (error instanceof Response) throw error; throw new Response('invalid JSON', { status: 400 }); }
}
export function asWorkerError(error: unknown): Response {
  if (error instanceof Response) return error;
  return Response.json({ error: error instanceof Error ? error.message : 'worker request failed' }, { status: 409, headers: { 'cache-control': 'no-store' } });
}
