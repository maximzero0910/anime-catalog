import { getTitles } from '../db';
import { freshTelegramVideo, getTelegramChannel, getTelegramClient, telegramConfigured } from '../telegram/client';
import { getPlayableTelegramMessage, matchedTelegramEpisodes } from '../telegram/storage';
import type { AudioMode, EpisodeRef, Provider, SearchHit, StreamSource } from './types';

const priority = Number(process.env.TELEGRAM_PROVIDER_PRIORITY ?? 10);
const provider: Provider = {
  id: 'telegram', weight: Number.isFinite(priority) ? priority : 10, score: 1,
  async searchByTitle(query: string): Promise<SearchHit[]> {
    const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const q = normalize(query);
    if (!q) return [];
    return getTitles()
      .filter(title => [title.english, title.romaji, title.native, title.title_bg].some(value => Boolean(value && (normalize(value) === q || normalize(value).includes(q) || q.includes(normalize(value))))))
      .map(title => ({ id: String(title.id), title: title.english ?? title.romaji ?? title.native ?? String(title.id), alt: [title.romaji, title.native, title.title_bg].filter((value): value is string => Boolean(value)) }));
  },
  async listEpisodes(seriesId: string): Promise<EpisodeRef[]> {
    return matchedTelegramEpisodes(Number(seriesId)).filter(row => row.status === 'MATCHED' && Number(row.verified) === 1 && Number(row.primary_match) === 1).map(row => ({ num: Number(row.episode_number), id: String(row.message_id) })).sort((a, b) => a.num - b.num);
  },
  async resolve(episodeId: string, mode: AudioMode): Promise<StreamSource[]> {
    if (!telegramConfigured()) return [];
    const messageId = Number(episodeId);
    if (!Number.isSafeInteger(messageId) || messageId < 1) return [];
    if (!getPlayableTelegramMessage(messageId)) return [];
    try {
      const { row } = await freshTelegramVideo(messageId);
      return [{ url: `/api/telegram/media/${messageId}`, type: 'mp4', quality: 'auto', headers: {}, subtitles: [], audio: mode, provider: this.id }];
    } catch (error) {
      console.warn({ provider: this.id, ep: episodeId, reason: error instanceof Error ? error.message : String(error), indexedSize: rowSize(messageId) });
      return [];
    }
  },
  async health(): Promise<boolean> {
    if (!telegramConfigured()) return false;
    try { const client = await getTelegramClient(); await getTelegramChannel(client); return true; } catch { return false; }
  },
};
function rowSize(messageId: number): number { return Number(matchedTelegramEpisodes().find(row => Number(row.message_id) === messageId)?.file_size ?? 0); }
export default provider;

