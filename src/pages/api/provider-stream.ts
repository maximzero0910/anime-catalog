import { getProvider, ordered } from '../../lib/providers';
import { ProviderError, verifyPlayablePlaylist, type AudioMode, type StreamSource } from '../../lib/providers/types';
import { isUsableSubtitleTrackUrl } from '../../lib/subtitle-track-url';
import { proxySubtitleTracks } from '../../lib/hls-proxy';
import { resolveExactTitleFallback } from '../../lib/providers/fallback';

export const prerender = false;

export async function GET({ request }: { request: Request }): Promise<Response> {
  const url = new URL(request.url);
  const providerId = url.searchParams.get('provider') ?? '';
  const episodeId = url.searchParams.get('episodeId') ?? '';
  const mode: AudioMode = url.searchParams.get('audio') === 'dub' ? 'dub' : 'sub';
  const title = url.searchParams.get('title')?.trim().slice(0, 160) ?? '';
  const episodeNumber = Number(url.searchParams.get('number'));
  const provider = getProvider(providerId);
  if (!provider || !episodeId) return Response.json({ error: 'invalid-provider-episode' }, { status: 400 });

  try {
    const respond = async (source: StreamSource): Promise<Response | null> => {
      if (source.provider === 'telegram' && source.type === 'mp4' && source.url.startsWith('/api/telegram/media/')) {
        return Response.json({ url: source.url, type: source.type, quality: source.quality, headers: source.headers, subtitles: [], audio: source.audio, provider: source.provider, hardsub: 'bg' });
      }
      if (source.provider === 'playtube' && source.type === 'mp4') {
        const proxy = new URL('/api/hls', url.origin);
        proxy.searchParams.set('u', source.url);
        proxy.searchParams.set('r', source.headers.referer ?? 'https://playtube.tv/');
        return Response.json({ url: `${proxy.pathname}${proxy.search}`, type: source.type, quality: source.quality, headers: {}, subtitles: [], audio: source.audio, provider: source.provider, hardsub: 'bg' }, { headers: { 'cache-control': 'no-store' } });
      }
      if (source.type === 'hls' && /^https?:\/\//i.test(source.url) && await verifyPlayablePlaylist(source.url, source.headers)) {
        const subtitles = proxySubtitleTracks(
          source.subtitles.filter(track => isUsableSubtitleTrackUrl(track.url)),
          source.headers.referer ?? `${new URL(source.url).origin}/`,
        );
        return Response.json({ url: source.url, type: source.type, quality: source.quality, headers: source.headers, subtitles, audio: source.audio, provider: source.provider }, { headers: { 'cache-control': 'no-store' } });
      }
      return null;
    };
    let primarySources: StreamSource[] = [];
    try { primarySources = await provider.resolve(episodeId, mode); }
    catch (error) {
      console.warn({ provider: provider.id, stage: 'primary-resolution', reason: error instanceof ProviderError ? error.kind : 'network' });
    }
    for (const source of primarySources) {
      const response = await respond(source);
      if (response) return response;
    }
    if (title && Number.isSafeInteger(episodeNumber) && episodeNumber > 0) {
      const fallback = await resolveExactTitleFallback(title, episodeNumber, ordered(), provider.id, mode, source =>
        source.type === 'hls' && /^https?:\/\//i.test(source.url) ? verifyPlayablePlaylist(source.url, source.headers) : Promise.resolve(source.type === 'mp4'),
      );
      if (fallback) {
        const response = await respond(fallback);
        if (response) return response;
      }
    }
    throw new ProviderError('empty', provider.id, `${provider.id}: no verified HLS source`);
  } catch (error) {
    const reason = error instanceof ProviderError ? error.kind : 'network';
    console.error({ provider: provider.id, ep: episodeId, reason });
    return Response.json({ error: reason, provider: provider.id }, { status: 502 });
  }
}
