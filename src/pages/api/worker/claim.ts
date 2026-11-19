import { claimKaggleJob } from '../../../lib/subtitles/kaggle-worker';
import { asWorkerError, workerJson } from '../../../lib/subtitles/kaggle-route';
export const prerender = false;
export async function POST({ request }: { request: Request }): Promise<Response> {
  try { const body = await workerJson<{ workerId: string }>(request, 4096); if (typeof body.workerId !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(body.workerId)) return Response.json({ error: 'invalid workerId' }, { status: 400 }); return Response.json({ job: await claimKaggleJob(body.workerId) }, { headers: { 'cache-control': 'no-store' } }); }
  catch (error) { return asWorkerError(error); }
}
