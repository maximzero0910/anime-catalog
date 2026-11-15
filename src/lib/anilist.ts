const endpoint = 'https://graphql.anilist.co';
export async function queryAniList<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (!response.ok) throw new Error(`AniList GraphQL returned ${response.status}`);
  const result = await response.json() as { data: T };
  return result.data;
}
