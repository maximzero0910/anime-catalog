interface Coverage {
  available: number;
  total: number;
  complete: boolean;
}

interface CoverageResponse {
  coverage?: Record<string, Coverage>;
  episodes?: Record<string, number[]>;
}

let refreshListenersInstalled = false;

function startCoverageRefresh(): void {
  if (refreshListenersInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
  refreshListenersInstalled = true;
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void refreshBulgarianCoverage(document);
  }, 60_000);
  window.addEventListener('focus', () => void refreshBulgarianCoverage(document));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshBulgarianCoverage(document);
  });
}

export async function refreshBulgarianCoverage(root: ParentNode = document): Promise<void> {
  startCoverageRefresh();
  const badges = [...root.querySelectorAll<HTMLElement>('[data-bg-coverage-badge][data-anime-id]')];
  const ids = [...new Set(badges.map(badge => Number(badge.dataset.animeId)).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return;

  try {
    const response = await fetch(`/api/subtitles/coverage?ids=${ids.join(',')}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return;
    const body = await response.json() as CoverageResponse;
    if (!body.coverage || typeof body.coverage !== 'object') return;

    for (const badge of badges) {
      const value = body.coverage[badge.dataset.animeId ?? ''];
      if (!value || !Number.isSafeInteger(value.available) || !Number.isSafeInteger(value.total) || typeof value.complete !== 'boolean') continue;
      badge.hidden = value.available <= 0;
      badge.classList.toggle('complete', value.complete);
      badge.textContent = value.complete ? 'BG · ПЪЛНО' : 'BG · ЧАСТИЧНО';
      badge.title = `${value.available} от ${value.total} епизода имат български субтитри`;
      badge.setAttribute('aria-label', value.complete ? 'Български субтитри за всички епизоди' : `Български субтитри за ${value.available} от ${value.total} епизода`);
    }

    const episodeLists = [...root.querySelectorAll<HTMLElement>('[data-episode-list][data-anime-id]')];
    for (const list of episodeLists) {
      const animeId = list.dataset.animeId ?? '';
      const available = new Set(body.episodes?.[animeId] ?? []);
      for (const link of list.querySelectorAll<HTMLElement>('[data-episode-number]')) {
        const episode = Number(link.dataset.episodeNumber);
        const existing = link.querySelector<HTMLElement>('[data-bg-episode-badge]');
        if (!available.has(episode)) {
          existing?.remove();
          continue;
        }
        if (existing || [...link.querySelectorAll<HTMLElement>('.badge')].some(item => /хардсаб/i.test(item.textContent ?? ''))) continue;
        const episodeBadge = document.createElement('span');
        episodeBadge.className = 'badge';
        episodeBadge.dataset.bgEpisodeBadge = '';
        episodeBadge.textContent = 'БГ';
        link.append(episodeBadge);
      }
    }
    if (typeof document !== 'undefined') document.dispatchEvent(new Event('anineko:bg-coverage-updated'));
  } catch {
    // Keep the build-time badge if the live backend is offline or times out.
  }
}
