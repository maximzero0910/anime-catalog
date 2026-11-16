import { getTitleById } from '../../../../lib/db';
import { ordered } from '../../../../lib/providers';
import { getTelegramEpisode } from '../../../../lib/telegram/storage';
import type { Provider, SearchHit } from '../../../../lib/providers/types';

export const prerender = false;

const labels: Record<string, string> = { telegram: 'Telegram · БГ хардсаб', playtube: 'PlayTube', '9anime': '9Anime', reanime: 'ReAnime', allanime: 'AllAnime', anikoto: 'AniKoto' };
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
async function withTimeout<T>(work: Promise<T>, ms = 9000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('provider discovery timed out')), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function titleMatch(provider: Provider, query: string, aliases: string[]): Promise<SearchHit | undefined> {
  const hits = await provider.searchByTitle(query);
  const wanted = aliases.map(normalize).filter(Boolean);
  const ranked = hits.map(hit => {
    const names = [hit.title, ...(hit.alt ?? [])].map(normalize).filter(Boolean);
    const score = Math.max(0, ...names.flatMap(name => wanted.map(term => name === term ? 1 : name.includes(term) || term.includes(name) ? Math.min(name.length, term.length) / Math.max(name.length, term.length) : 0)));
    return { hit, score };
  }).sort((a, b) => b.score - a.score);
  return ranked[0] && ranked[0].score >= 0.72 ? ranked[0].hit : undefined;
}

export async function GET({ params }: { params: { animeId?: string; episode?: string } }): Promise<Response> {
  const animeId = Number(params.animeId);
  const episode = Number(params.episode);
  if (!Number.isSafeInteger(animeId) || animeId < 1 || !Number.isSafeInteger(episode) || episode < 1) return Response.json({ error: 'invalid-anime-episode' }, { status: 400 });
  const title = getTitleById(animeId);
  if (!title) return Response.json({ error: 'anime-not-found' }, { status: 404 });
  const name = title.title_bg ?? title.english ?? title.romaji ?? title.native ?? String(title.id);
  const aliases = [title.title_bg, title.english, title.romaji, title.native].filter((value): value is string => Boolean(value));
  const options: Array<{ provider: string; label: string; episodeId: string; hardsub?: 'bg' }> = [];
  const telegram = getTelegramEpisode(animeId, episode);
  if (telegram) options.push({ provider: 'telegram', label: labels.telegram!, episodeId: String(telegram.message_id), hardsub: 'bg' });
  const providers = ordered().filter(provider => provider.id !== 'telegram');
  const found = await Promise.allSettled(providers.map(async provider => {
    return withTimeout((async () => {
      const hit = await titleMatch(provider, name, aliases);
      if (!hit) return null;
      const refs = await provider.listEpisodes(hit.id);
      const ref = refs.find(item => item.num === episode);
      return ref ? { provider: provider.id, label: labels[provider.id] ?? provider.id, episodeId: ref.id } : null;
    })(), 12_000);
  }));
  for (const result of found) if (result.status === 'fulfilled' && result.value) options.push(result.value);
  return Response.json({ animeId, episode, title: name, options }, { headers: { 'cache-control': 'private, max-age=60' } });
}
