import { getProvider } from '../../lib/providers';
import { ProviderError } from '../../lib/providers/types';

export const prerender = false;

/** Search and episode lookup for providers implemented in this application. */
export async function GET({ request }: { request: Request }): Promise<Response> {
  const url = new URL(request.url);
  const providerId = url.searchParams.get('provider') ?? '';
  const action = url.searchParams.get('action') ?? 'search';
  const provider = getProvider(providerId);
  if (!provider || !['search', 'info'].includes(action)) {
    return Response.json({ error: 'unsupported-provider-action', provider: providerId, action }, { status: 400 });
  }

  try {
    if (action === 'search') {
      const query = url.searchParams.get('q')?.trim() ?? '';
      if (!query) return Response.json({ results: [] });
      const results = await provider.searchByTitle(query);
      return Response.json({ results: results.map(hit => ({ id: hit.id, title: hit.title, ...(hit.alt?.length ? { alt: hit.alt } : {}) })) });
    }

    const id = url.searchParams.get('id') ?? '';
    if (!id) return Response.json({ error: 'missing-series-id' }, { status: 400 });
    const episodes = await provider.listEpisodes(id);
    return Response.json({ id, title: id, episodes: episodes.map(episode => ({ id: episode.id, number: episode.num, title: `Episode ${episode.num}` })) });
  } catch (error) {
    const reason = error instanceof ProviderError ? error.kind : 'network';
    console.error({ provider: providerId, action, reason, message: error instanceof Error ? error.message : String(error) });
    return Response.json({ error: reason, provider: providerId }, { status: 502 });
  }
}
