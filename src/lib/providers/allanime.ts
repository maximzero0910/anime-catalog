import { abs, httpGet, httpPost, qualityFrom, type AudioMode, type EpisodeRef, type Provider, type SearchHit, type StreamSource } from './types';

const id = 'allanime';
const API = 'https://api.allanime.day/api';
const REFERER = 'https://allanime.day/';
const SEARCH_QUERY = 'query($search:SearchInput,$limit:Int,$page:Int,$translationType:VaildTranslationTypeEnumType,$countryOrigin:VaildCountryOriginEnumType){shows(search:$search,limit:$limit,page:$page,translationType:$translationType,countryOrigin:$countryOrigin){edges{_id name englishName availableEpisodes __typename}}}';
const EPISODES_QUERY = 'query($showId:String!){show(_id:$showId){_id availableEpisodesDetail}}';
const SOURCES_QUERY = 'query($showId:String!,$episodeString:String!,$translationType:VaildTranslationTypeEnumType!){episode(showId:$showId,episodeString:$episodeString,translationType:$translationType){sourceUrls}}';

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const url = new URL(API);
  url.searchParams.set('variables', JSON.stringify(variables));
  url.searchParams.set('query', query);
  const { text, status } = await httpPost(url.href, '', {
    provider: id,
    referer: REFERER,
    retries: 1,
    headers: { accept: 'application/json', origin: 'https://allanime.day' },
  });
  if (status < 200 || status >= 300) throw new Error(`AllAnime GraphQL returned HTTP ${status}`);
  try { return JSON.parse(text) as T; } catch { throw new Error('AllAnime returned invalid JSON'); }
}

type SearchData = { data?: { shows?: { edges?: Array<{ _id: string; name?: string; englishName?: string }> } } };
type EpisodesData = { data?: { show?: { availableEpisodesDetail?: Record<string, string[]> } } };
type SourcesData = { data?: { episode?: { sourceUrls?: Array<{ sourceUrl: string }> } } };
type LinkResponse = { links?: Array<{ link: string; hls?: boolean; mp4?: boolean; resolutionStr?: string }> };

export const allanime: Provider = {
  id,
  weight: 1,
  score: 1,
  async searchByTitle(q: string): Promise<SearchHit[]> {
    const result = await graphql<SearchData>(SEARCH_QUERY, { search: { allowAdult: false, allowUnknown: false, query: q }, limit: 20, page: 1, translationType: 'sub', countryOrigin: 'ALL' });
    return (result.data?.shows?.edges ?? []).map(show => ({ id: show._id, title: show.englishName || show.name || show._id, ...(show.name && show.englishName && show.name !== show.englishName ? { alt: [show.name] } : {}) }));
  },
  async listEpisodes(seriesId: string): Promise<EpisodeRef[]> {
    const result = await graphql<EpisodesData>(EPISODES_QUERY, { showId: seriesId });
    const detail = result.data?.show?.availableEpisodesDetail ?? {};
    const episodes: EpisodeRef[] = [];
    for (const [audio, values] of Object.entries(detail)) {
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        const num = Number(value);
        if (Number.isFinite(num) && !episodes.some(episode => episode.num === num)) episodes.push({ num, id: `${seriesId}|${audio}|${value}` });
      }
    }
    return episodes.sort((a, b) => a.num - b.num);
  },
  async resolve(episodeId: string, mode: AudioMode): Promise<StreamSource[]> {
    const [showId, encodedAudio, episode] = episodeId.split('|');
    const translationType = encodedAudio || mode;
    const result = await graphql<SourcesData>(SOURCES_QUERY, { showId, episodeString: episode ?? episodeId, translationType });
    const sources: StreamSource[] = [];
    for (const entry of result.data?.episode?.sourceUrls ?? []) {
      let path = entry.sourceUrl;
      if (path.startsWith('--')) {
        try {
          const hex = path.slice(2);
          path = String.fromCharCode(...hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
        } catch { continue; }
        path = abs(REFERER, path);
      }
      try {
        const { text, status } = await httpGet(path, { provider: id, referer: REFERER });
        if (status < 200 || status >= 300) continue;
        const links = (JSON.parse(text) as LinkResponse).links ?? [];
        for (const link of links) {
          if (!link.hls && !link.mp4) continue;
          sources.push({ url: link.link, quality: qualityFrom(link.resolutionStr ?? ''), type: link.hls ? 'hls' : 'mp4', headers: { referer: REFERER }, subtitles: [], audio: mode, provider: id });
        }
      } catch { /* Try the next encoded source. */ }
    }
    return sources;
  },
  async health(): Promise<boolean> {
    try { await graphql<SearchData>(SEARCH_QUERY, { search: { query: 'Cowboy Bebop' }, limit: 1, page: 1, translationType: 'sub', countryOrigin: 'ALL' }); return true; } catch { return false; }
  },
};

export default allanime;
