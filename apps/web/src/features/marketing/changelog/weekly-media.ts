export interface WeeklyMedia {
  cover: { url: string; alt: string; width: number; height: number };
  demoUrl?: string;
}

const COVER_HOST = 'ke4pydspzeg0nm0o.public.blob.vercel-storage.com';

function publicUrl(value: unknown, hosts: string[]): URL | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      hosts.includes(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash
    )
      return url;
  } catch {
    /* Malformed external data is omitted. */
  }
}

/** Only explicitly reviewed media on the existing public asset host is publishable. */
export function parseWeeklyMedia(value: unknown): WeeklyMedia | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('reviewed' in value) ||
    value.reviewed !== true ||
    !('cover' in value)
  )
    return;
  const cover = value.cover;
  if (
    !cover ||
    typeof cover !== 'object' ||
    !('url' in cover) ||
    !('alt' in cover) ||
    !('width' in cover) ||
    !('height' in cover)
  )
    return;
  const url = publicUrl(cover.url, [COVER_HOST]);
  if (
    !url ||
    url.search ||
    !/\.(png|jpe?g|webp|avif)$/i.test(url.pathname) ||
    typeof cover.alt !== 'string' ||
    !cover.alt.trim() ||
    typeof cover.width !== 'number' ||
    typeof cover.height !== 'number' ||
    !Number.isInteger(cover.width) ||
    !Number.isInteger(cover.height) ||
    cover.width < 1 ||
    cover.height < 1 ||
    cover.width > 8192 ||
    cover.height > 8192
  )
    return;
  const demo =
    'demoUrl' in value
      ? publicUrl(value.demoUrl, ['www.youtube.com', 'youtube.com', 'youtu.be', 'www.loom.com'])
      : undefined;
  return {
    cover: { url: url.href, alt: cover.alt.trim(), width: cover.width, height: cover.height },
    ...(demo ? { demoUrl: demo.href } : {}),
  };
}
