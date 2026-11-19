import { getBulgarianCoverageMany, getBulgarianEpisodesMany } from '../../../lib/db';

export const prerender = false;

export function GET({ request }: { request: Request }): Response {
  const rawIds = new URL(request.url).searchParams.get('ids') ?? '';
  if (!rawIds || rawIds.length > 1200) {
    return Response.json({ error: 'invalid-anime-ids' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  const tokens = rawIds.split(',');
  if (tokens.length > 200 || tokens.some(value => !/^\d{1,10}$/.test(value))) {
    return Response.json({ error: 'invalid-anime-ids' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  const ids = tokens.map(Number);
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    return Response.json({ error: 'invalid-anime-ids' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  const coverage = getBulgarianCoverageMany(ids);
  const episodes = getBulgarianEpisodesMany(ids);
  return Response.json({ coverage: Object.fromEntries(coverage), episodes: Object.fromEntries(episodes) }, { headers: { 'cache-control': 'no-store' } });
}
