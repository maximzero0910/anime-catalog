import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { getSubtitle } from '../../../../lib/db';
import { formatTime, parseSubtitle } from '../../../../lib/subtitles/normalize';
import { enqueueOnDemandJob, getSubtitleHardsub, listArtifacts, readBody } from '../../../../lib/subtitles/storage';
import { getTitleById, getEpisodes } from '../../../../lib/db';
import { resolveIndexedBgSubtitle } from '../../../../lib/subtitles/index';
import { getAniListAnime } from '../../../../lib/anilist';

export const prerender = false;

// DECISION: use Anineko's persistent local queue for on-demand translation. The
// listed web tools do not expose a common unattended API and several gate work
// behind CAPTCHA, accounts, or credits; subtitle content stays on this server.

function asWebVtt(raw: string, format: string): string {
  if (format === 'vtt') return raw.startsWith('WEBVTT') ? raw : `WEBVTT\n\n${raw}`;
  const parsed = parseSubtitle(raw, format as 'srt' | 'ass' | 'ssa');
  const lines = parsed.cues.map(cue => {
    let text = cue.originalText;
    if (format === 'ass' || format === 'ssa') text = text.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ').replace(/\{\\i1\}/gi, '<i>').replace(/\{\\i0\}/gi, '</i>').replace(/\{\\b1\}/gi, '<b>').replace(/\{\\b0\}/gi, '</b>').replace(/\{[^}]*\}/g, '');
    return `${cue.id}\n${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${text}`;
  });
  return `WEBVTT\n\n${lines.join('\n\n')}\n`;
}

export async function GET({ params }: { params: { animeId?: string; episode?: string } }): Promise<Response> {
  const animeId = Number(params.animeId); const episode = Number(params.episode);
  if (!Number.isSafeInteger(animeId) || animeId <= 0 || !Number.isSafeInteger(episode) || episode <= 0) return new Response('invalid subtitle request', { status: 400 });
  const title = getTitleById(animeId);
  const episodeRow = title ? getEpisodes(animeId).find(item => item.number === episode) : undefined;
  let metadataTitle = title?.romaji || title?.english || title?.native || title?.title_bg || title?.slug;
  let episodeCount = title?.episodes;
  if (!title || !episodeRow) {
    try {
      const metadata = await getAniListAnime(animeId);
      if (!metadata) return new Response('anime episode not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      metadataTitle = metadata.title.english || metadata.title.romaji || metadata.title.native || String(animeId);
      episodeCount = metadata.episodes;
    } catch {
      return new Response('anime metadata is temporarily unavailable', { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '10' } });
    }
  }
  if (episodeCount && episode > episodeCount) return new Response('anime episode not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const indexed = await resolveIndexedBgSubtitle(String(animeId), episode, metadataTitle || String(animeId), episodeRow?.duration == null ? null : episodeRow.duration * 1000);
  if (indexed?.track) return new Response(indexed.track.body, { headers: {
    'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'public, max-age=3600',
    'x-subtitle-source': indexed.track.machineTranslated ? 'machine-translated' : 'provider', 'x-subtitle-language': 'bg', 'x-subtitle-score': String(indexed.track.qualityScore),
    // HTTP header values are ByteStrings; percent-encode attribution so Bulgarian text is preserved safely.
    'x-subtitle-attribution': encodeURIComponent(indexed.track.attribution), 'x-subtitle-attribution-encoding': 'percent-encoded-utf8', 'x-subtitle-verified': String(indexed.track.verified),
    'x-subtitle-machine-translated': String(indexed.track.machineTranslated),
  } });
  const artifact = listArtifacts(animeId, String(episode))[0];
  if (artifact && artifact.validation_status === 'validated' && artifact.target_language === 'bg') {
    try {
      const body = await readBody(String(artifact.translated_path));
      const vtt = asWebVtt(body, String(artifact.translated_format));
      return new Response(vtt, { headers: { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'public, max-age=86400', 'x-subtitle-source': String(artifact.model).startsWith('provider:') ? 'provider' : 'machine-translated', 'x-subtitle-score': String(artifact.score), 'x-subtitle-language': 'bg' } });
    } catch (error) { console.error('Could not read validated subtitle artifact', error); }
  }
  const legacy = getSubtitle(animeId, episode);
  if (legacy && ['qc', 'final'].includes(legacy.status) && legacy.path) {
    const root = resolve('public/subs'); const path = resolve(root, legacy.path);
    if (!path.startsWith(`${root}${sep}`)) return new Response('invalid subtitle path', { status: 400 });
    try { return new Response(await readFile(path), { headers: { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'public, max-age=86400', 'x-subtitle-source': legacy.translator ? 'machine-translated' : 'provider', 'x-subtitle-language': 'bg' } }); }
    catch { /* Missing legacy artifact falls through to the ordinary unavailable response. */ }
  }
  const hardsub = getSubtitleHardsub(animeId, episode);
  if (hardsub) return Response.json({ status: 'SKIPPED', hardsub: true, source: hardsub.source_id, title: hardsub.source_title }, { headers: { 'cache-control': 'no-store', 'x-subtitle-hardsub': 'bg' } });
  const job = enqueueOnDemandJob(animeId, episode);
  const active = !['COMPLETED', 'SKIPPED'].includes(job.status) && !(job.status === 'FAILED' && job.available_at === Number.MAX_SAFE_INTEGER);
  if (active) return Response.json({ status: job.status, jobId: job.id, catalogOnly: Boolean(indexed?.catalog) }, { status: 202, headers: {
    'cache-control': 'no-store', 'retry-after': '5',
    ...(indexed?.catalog ? {
      'x-subtitle-catalog-only': 'true', 'x-subtitle-source-url': indexed.catalog.sourceUrl,
      'x-subtitle-attribution': encodeURIComponent(indexed.catalog.attribution), 'x-subtitle-attribution-encoding': 'percent-encoded-utf8', 'x-subtitle-needs-fetch': 'true',
    } : {}),
  } });
  return Response.json({ status: job.status, jobId: job.id, error: job.error ?? 'No usable source subtitle is available.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
}
