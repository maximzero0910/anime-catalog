import { kaggleQueueStatus } from '../../../lib/subtitles/kaggle-worker';
export const prerender = false;
export function GET(): Response { return Response.json(kaggleQueueStatus(), { headers: { 'cache-control': 'no-store' } }); }
