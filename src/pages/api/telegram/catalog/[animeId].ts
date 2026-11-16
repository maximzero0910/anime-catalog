import { getTitleById } from '../../../../lib/db';
import { matchedTelegramEpisodes } from '../../../../lib/telegram/storage';

export const prerender = false;
export async function GET({ params }: { params: { animeId?: string } }): Promise<Response> {
  const animeId = Number(params.animeId);
  if (!Number.isSafeInteger(animeId) || animeId <= 0) return Response.json({ error: 'invalid-anime-id' }, { status: 400 });
  const title = getTitleById(animeId);
  if (!title) return Response.json({ error: 'anime-not-found' }, { status: 404 });
  const episodes = matchedTelegramEpisodes(animeId).filter(row => row.status === 'MATCHED' && Number(row.verified) === 1 && Number(row.primary_match) === 1)
    .map(row => ({ number: Number(row.episode_number), messageId: Number(row.message_id), season: row.season_number == null ? null : Number(row.season_number), hardsub: 'bg' as const }))
    .sort((a, b) => a.number - b.number);
  return Response.json({ animeId, slug: title.slug, title: title.title_bg ?? title.english ?? title.romaji ?? title.native ?? String(title.id), episodes }, { headers: { 'cache-control': 'no-store' } });
}
