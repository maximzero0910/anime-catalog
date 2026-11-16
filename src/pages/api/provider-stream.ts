import { getProvider } from '../../lib/providers';
import { ProviderError, verifyPlayablePlaylist, type AudioMode } from '../../lib/providers/types';
import { isUsableSubtitleTrackUrl } from '../../lib/subtitle-track-url';

export const prerender = false;

export async function GET({ request }: { request: Request }): Promise<Response> {
  const url = new URL(request.url);
  const providerId = url.searchParams.get('provider') ?? '';
  const episodeId = url.searchParams.get('episodeId') ?? '';
  const mode: AudioMode = url.searchParams.get('audio') === 'dub' ? 'dub' : 'sub';
  const provider = getProvider(providerId);
  if (!provider || !episodeId) return Response.json({ error: 'invalid-provider-episode' }, { status: 400 });

  try {
    const sources = await provider.resolve(episodeId, mode);
    for (const source of sources) {
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
        return Response.json({ url: source.url, type: source.type, quality: source.quality, headers: source.headers, subtitles: source.subtitles.filter(track => isUsableSubtitleTrackUrl(track.url)), audio: source.audio, provider: source.provider });
      }
    }
    throw new ProviderError('empty', provider.id, `${provider.id}: no verified HLS source`);
  } catch (error) {
    const reason = error instanceof ProviderError ? error.kind : 'network';
    console.error({ provider: provider.id, ep: episodeId, reason });
    return Response.json({ error: reason, provider: provider.id }, { status: 502 });
  }
}
