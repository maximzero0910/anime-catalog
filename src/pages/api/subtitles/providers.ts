import { providerStatus } from '../../../lib/subtitles/providers';

export const prerender = false;

export function GET(): Response {
  return Response.json({ providers: providerStatus(), generatedAt: new Date().toISOString() }, { headers: { 'cache-control': 'no-store' } });
}
