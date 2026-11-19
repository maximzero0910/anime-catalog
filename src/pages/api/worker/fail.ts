import { failKaggleJob } from '../../../lib/subtitles/kaggle-worker';
import { asWorkerError, workerJson } from '../../../lib/subtitles/kaggle-route';
export const prerender = false;
export async function POST({ request }: { request: Request }): Promise<Response> { try { const body = await workerJson<{ jobId: number; workerId: string; reason: string }>(request, 16_384); if (typeof body.reason !== 'string') return Response.json({ error: 'reason required' }, { status: 400 }); failKaggleJob(body); return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } }); } catch (error) { return asWorkerError(error); } }
