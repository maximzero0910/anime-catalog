(() => {
  const element = selector => {
    const found = document.querySelector(selector);
    if (!found) throw new Error(`Missing subtitle admin element: ${selector}`);
    return found;
  };
  const tokenInput = element('#admin-token');
  tokenInput.value = sessionStorage.getItem('subtitle-admin-token') ?? '';
  const message = value => { element('#admin-message').textContent = value; };
  const fmt = value => typeof value === 'number' ? new Intl.NumberFormat('bg-BG', { maximumFractionDigits: 1 }).format(value) : '—';
  const display = value => typeof value === 'number' ? fmt(value) : value == null || value === '' ? '—' : String(value);
  const escapeText = value => {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, char => entities[char] ?? char);
  };

  async function refresh() {
    try {
      const animeId = element('#glossary-anime').value;
      const response = await fetch(`/api/subtitles/admin${animeId ? `?animeId=${encodeURIComponent(animeId)}` : ''}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const animeSelect = element('#glossary-anime');
      if (animeSelect.options.length <= 1) animeSelect.insertAdjacentHTML('beforeend', data.titles.map(title => `<option value="${title.id}">${escapeText(title.name)} (${title.id})</option>`).join(''));

      const cards = [
        ['Каталог', data.eligibleEpisodes], ['Български', data.alreadyBulgarian], ['В опашката', data.awaiting], ['В обработка', data.inFlight],
        ['Завършени', data.completed], ['Неуспешни', data.failed], ['Пропуснати', data.skipped], ['Епизода/час', data.throughputPerHour],
        ['Куи/час (активно)', data.activeCuesPerHour], ['Преведени куи (активно)', data.activeTranslatedCues],
        ['Текущ епизод оставащи (часа)', data.activeEpisodeRemainingSeconds === null ? null : data.activeEpisodeRemainingSeconds / 3600],
        ['Средно време (сек.)', data.meanTranslationSeconds], ['Оставащи часове', data.estimatedRemainingSeconds === null ? null : data.estimatedRemainingSeconds / 3600],
        ['RAM използвана (%)', data.resources.memoryUsedPercent], ['Worker процес', data.worker], ['Worker контрол', data.workerControl], ['Преводач', 'Онлайн сайтове'],
        ['Индекс: заглавия', data.subtitleIndex.titles], ['Всички индексни записи', data.subtitleIndex.entries],
        ['Готови за пускане', data.subtitleIndex.playableRows], ['Само каталожни', data.subtitleIndex.catalogOnlyRows],
        ['Проверени записи', data.subtitleIndex.verifiedRows], ['Готови BG файла', data.subtitleIndex.assets],
        ['За проверка', data.subtitleIndex.verificationQueued], ['Индекс: чакащи', data.subtitleIndex.queued],
        ['Индекс: в работа', data.subtitleIndex.running], ['Индекс: грешки', data.subtitleIndex.failed],
      ];
      if (data.resources.gpu) cards.push(['GPU', `${data.resources.gpu.name}: ${data.resources.gpu.utilizationPercent}% · ${data.resources.gpu.vramUsedMiB}/${data.resources.gpu.vramTotalMiB} MiB`]);
      element('#index-providers').innerHTML = data.subtitleIndexProviders.map(item =>
        `<tr><td>${escapeText(item.provider)}</td><td>${fmt(item.indexedRows)}</td><td>${fmt(item.playableRows)}</td><td>${fmt(item.catalogOnlyRows)}</td><td>${fmt(item.verifiedRows)}</td></tr>`,
      ).join('') || '<tr><td colspan="5">Няма индексни записи.</td></tr>';
      element('#index-review').innerHTML = data.subtitleIndexReview.map(item =>
        `<tr><td>${escapeText(`${item.english ?? item.romaji ?? `AniList ${item.anime_id}`} · ep ${item.episode_number}`)}</td><td>${escapeText(item.provider)}</td><td>${fmt(item.quality_score)}</td><td>${escapeText(item.reason)}</td><td><button data-index-action="verify-index" data-index="${escapeText(item.index_id)}">Потвърди</button><button data-index-action="reject-index" data-index="${escapeText(item.index_id)}">Отхвърли</button></td></tr>`,
      ).join('') || '<tr><td colspan="5">Няма кандидати за проверка.</td></tr>';
      element('#title-mappings').innerHTML = data.needsMapping.map(item =>
        `<tr><td>${escapeText(`${item.anilist_id} · ep ${item.episode_number}`)}</td><td>${escapeText(item.source_id)}</td><td>${escapeText(item.source_title)}</td><td>${fmt(item.score)}</td><td><button data-mapping-action="map-title-candidate" data-mapping="${escapeText(item.id)}">Свържи</button><button data-mapping-action="reject-title-candidate" data-mapping="${escapeText(item.id)}">Отхвърли</button></td></tr>`,
      ).join('') || '<tr><td colspan="5">Няма кандидати за свързване.</td></tr>';
      element('#metrics').innerHTML = cards.map(([label, value]) => `<div class="metric"><strong>${escapeText(display(value))}</strong><span>${escapeText(label)}</span></div>`).join('');
      element('#concurrency').value = String(data.concurrency);
      element('#jobs').innerHTML = data.jobs.map(job =>
        `<tr><td>${escapeText(`${job.english ?? job.romaji ?? `AniList ${job.anime_id}`} · ep ${job.episode_id}`)}</td><td>${escapeText(job.status)}</td><td>${escapeText(job.attempts)}</td><td>${escapeText(job.updated_at)}</td><td>${job.status === 'COMPLETED' ? `<a href="/api/subtitles/${encodeURIComponent(String(job.anime_id))}/${encodeURIComponent(String(job.episode_id))}" target="_blank" rel="noreferrer">Провери VTT</a>` : ''}<button data-job="${escapeText(job.id)}" data-job-action="retry">Повтори</button><button data-job="${escapeText(job.id)}" data-job-action="skip">Пропусни</button></td></tr>`,
      ).join('') || '<tr><td colspan="5">Опашката е празна.</td></tr>';
      element('#dead-letters').innerHTML = data.deadLetters.map(item => `<li>Задача ${escapeText(item.job_id)} · ${escapeText(item.reason)}</li>`).join('') || '<li>Няма грешки.</li>';
      element('#glossary-entries').innerHTML = data.glossary.map(entry => `<li><strong>${escapeText(entry.source)}</strong> → ${escapeText(entry.target)}${entry.note ? ` · ${escapeText(entry.note)}` : ''}</li>`).join('') || '<li>Няма запазени термини.</li>';
      element('#models').textContent = `Преводът използва онлайн сайтове. CPU: ${data.resources.cpuCount}; системен товар: ${data.resources.loadAverage.map(fmt).join(' / ')}.`;
    } catch (error) {
      message(`Неуспешно обновяване: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function action(body) {
    const token = sessionStorage.getItem('subtitle-admin-token') ?? '';
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      const response = await fetch('/api/subtitles/admin', { method: 'POST', headers, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      message('Промяната е записана.');
      await refresh();
    } catch (error) {
      message(error instanceof Error ? error.message : String(error));
    }
  }

  document.querySelector('#save-token')?.addEventListener('click', () => {
    sessionStorage.setItem('subtitle-admin-token', tokenInput.value);
    message('Токенът се пази до затваряне на тази сесия.');
  });
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
    const kind = button.dataset.action;
    if (kind === 'enqueue') { void action({ action: kind, cap: Number(element('#queue-cap').value) }); return; }
    if (kind === 'set-concurrency') { void action({ action: 'concurrency', value: Number(element('#concurrency').value) }); return; }
    if (kind === 'save-glossary') {
      const animeId = Number(element('#glossary-anime').value);
      const source = element('#glossary-source').value.trim();
      const target = element('#glossary-target').value.trim();
      const note = element('#glossary-note').value.trim();
      if (!animeId || !source || !target) { message('Изберете сериал и попълнете оригиналния термин и превода.'); return; }
      void action({ action: kind, animeId, entries: [{ source, target, note }] });
      return;
    }
    if (kind === 'add-title-alias') {
      const anilistId = Number(element('#alias-anime-id').value);
      const sourceTitle = element('#alias-source-title').value.trim();
      if (!anilistId || !sourceTitle) { message('Попълнете AniList ID и заглавието в източника.'); return; }
      void action({ action: kind, anilistId, sourceId: element('#alias-source').value, sourceTitle });
      return;
    }
    if (kind) void action({ action: kind });
  }));
  element('#jobs').addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('[data-job-action]') : null;
    if (button) void action({ action: button.dataset.jobAction, id: Number(button.dataset.job) });
  });
  element('#index-review').addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('[data-index-action]') : null;
    if (!button) return;
    const evidence = window.prompt('Посочете проверените данни: заглавие/епизод, cue timing или cut duration.');
    if (!evidence || evidence.trim().length < 8) return;
    void action({ action: button.dataset.indexAction, indexId: Number(button.dataset.index), evidence: evidence.trim() });
  });
  element('#title-mappings').addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('[data-mapping-action]') : null;
    if (button) void action({ action: button.dataset.mappingAction, id: Number(button.dataset.mapping) });
  });
  element('#glossary-anime').addEventListener('change', () => void refresh());
  void refresh();
  window.setInterval(() => void refresh(), 10_000);
})();
