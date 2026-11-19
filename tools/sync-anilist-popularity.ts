import { queryAniList } from '../src/lib/anilist';
import { syncAniListPopularity } from '../src/lib/subtitles/storage';

const query = (page: number) => `query { Page(page: ${page}, perPage: 50) { media(type: ANIME, sort: POPULARITY_DESC) { id popularity seasonYear format title { romaji english native } synonyms } } }`;
interface ResponseShape { Page: { media: Array<{ id:number; popularity:number|null; seasonYear:number|null; format:string|null; title:{romaji:string|null;english:string|null;native:string|null}; synonyms:string[] }> } }
const pages = await Promise.all([1,2].map(page => queryAniList<ResponseShape>(query(page))));
const media = pages.flatMap(result => result.Page?.media ?? []);
if (media.length !== 100) throw new Error(`AniList popularity sync returned ${media.length} entries instead of 100`);
const rows = media.map((item,index)=>({id:item.id,popularity:item.popularity??0,rank:index+1,romaji:item.title.romaji,english:item.title.english,native:item.title.native,synonyms:item.synonyms??[],title:item.title.english??item.title.romaji??item.title.native??String(item.id),format:item.format,seasonYear:item.seasonYear}));
const matched = syncAniListPopularity(rows);
console.info(JSON.stringify({event:'anilist_popularity_synced',count:rows.length,matched,unmatched:rows.length-matched,at:new Date().toISOString()}));
