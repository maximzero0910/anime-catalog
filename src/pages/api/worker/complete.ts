import { completeKaggleJob } from '../../../lib/subtitles/kaggle-worker';
import { asWorkerError, workerJson } from '../../../lib/subtitles/kaggle-route';
export const prerender = false;
export async function POST({ request }: { request: Request }): Promise<Response> { try { const body = await workerJson<{ jobId: number; workerId: string; translatedText: string; model?: string; translationVersion?: string }>(request); return Response.json(await completeKaggleJob(body), { headers: { 'cache-control': 'no-store' } }); } catch (error) { return asWorkerError(error); } }
