const subtitleExtensions = new Set(['vtt', 'srt', 'ass', 'ssa']);
const imageExtensions = new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'webp']);

export function isUsableSubtitleTrackUrl(value: string): boolean {
  try {
    if (value.startsWith('/')) {
      const url = new URL(value, 'https://anineko.invalid');
      return url.pathname === '/api/hls' && url.searchParams.has('t') && !url.searchParams.has('u');
    }
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const pathname = decodeURIComponent(url.pathname).replaceAll('\\', '/');
    if (/(?:^|\/)(?:preview|thumbnails?)(?:\/|$)/i.test(pathname)) return false;
    const filename = pathname.split('/').filter(Boolean).at(-1) ?? '';
    if (/(?:^|[._-])sprite(?:[._-]|$)/i.test(filename)) return false;
    const extension = filename.split('.').at(-1)?.toLowerCase() ?? '';
    if (imageExtensions.has(extension)) return false;
    return !extension || subtitleExtensions.has(extension);
  } catch {
    return false;
  }
}
