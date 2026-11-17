/**
 * Cache only an authoritative empty provider result. Network, parse, and asset
 * storage failures must throw through so the persistent job can retry them.
 */
export async function indexProviderCandidates<Candidate>(input: {
  search: () => Promise<Candidate[]>;
  recordDefinitiveMiss: () => void;
  isAlreadyIndexed?: (candidate: Candidate) => boolean;
  index: (candidate: Candidate) => Promise<void>;
}): Promise<number> {
  const candidates = await input.search();
  if (!candidates.length) {
    input.recordDefinitiveMiss();
    return 0;
  }
  let indexed = 0;
  for (const candidate of candidates) {
    if (input.isAlreadyIndexed?.(candidate)) continue;
    await input.index(candidate);
    indexed++;
  }
  return indexed;
}
