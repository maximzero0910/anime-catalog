import { checkpointKaggleJob } from '../../../lib/subtitles/kaggle-worker';
import { asWorkerError, workerJson } from '../../../lib/subtitles/kaggle-route';

export const prerender = false;

export async function POST({ request }: { request: Request }): Promise<Response> {
  try {
    const body = await workerJson<{ jobId: number; workerId: string; translatedText: string }>(request);
    if (!Number.isSafeInteger(body.jobId) || !/^[a-zA-Z0-9._-]{1,80}$/.test(body.workerId) || typeof body.translatedText !== 'string') {
      return Response.json({ error: 'invalid checkpoint payload' }, { status: 400, headers: { 'cache-control': 'no-store' } });
    }
    return Response.json(await checkpointKaggleJob(body), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return asWorkerError(error); }
}
