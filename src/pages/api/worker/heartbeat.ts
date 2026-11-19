import { heartbeatKaggleJob } from '../../../lib/subtitles/kaggle-worker';
import { asWorkerError, workerJson } from '../../../lib/subtitles/kaggle-route';
export const prerender = false;
export async function POST({ request }: { request: Request }): Promise<Response> { try { const body = await workerJson<{ jobId: number; workerId: string }>(request, 4096); return Response.json({ ok: heartbeatKaggleJob(body) }, { headers: { 'cache-control': 'no-store' } }); } catch (error) { return asWorkerError(error); } }
