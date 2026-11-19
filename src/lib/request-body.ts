export class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413, message: string) { super(message); this.name = 'RequestBodyError'; }
}

export async function readJsonBody<T>(request: Request, maximumBytes = 1_048_576): Promise<T> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new RequestBodyError(413, 'request body too large');
  if (!request.body) throw new RequestBodyError(400, 'invalid JSON');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new RequestBodyError(413, 'request body too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(400, 'invalid JSON');
  }
}
