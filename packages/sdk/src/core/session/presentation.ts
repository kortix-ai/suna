import { type SubdomainUrlOptions, buildStaticFilePreviewUrl, hasPreviewTarget } from './url';

export type RuntimePresentationFormat = 'pdf' | 'pptx';

function trimTrailingSlashes(value: string): string {
  let trimmed = value;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

export function buildPresentationTemplatePdfUrl(backendUrl: string, templateId: string): string {
  return `${trimTrailingSlashes(backendUrl)}/presentation-templates/${encodeURIComponent(templateId)}/pdf#toolbar=0&navpanes=0&scrollbar=0&view=FitH`;
}

export function buildPresentationTemplateImageUrl(backendUrl: string, templateId: string): string {
  return `${trimTrailingSlashes(backendUrl)}/presentation-templates/${encodeURIComponent(templateId)}/image.png`;
}

export function buildRuntimePresentationConversionUrl(
  runtimeUrl: string,
  format: RuntimePresentationFormat,
): string {
  return `${trimTrailingSlashes(runtimeUrl)}/presentation/convert-to-${format}`;
}

export interface ConvertRuntimePresentationOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onGenerating?: () => void;
}

export async function convertRuntimePresentation(
  format: RuntimePresentationFormat,
  runtimeUrl: string,
  presentationPath: string,
  options?: ConvertRuntimePresentationOptions,
): Promise<Blob> {
  const endpoint = buildRuntimePresentationConversionUrl(runtimeUrl, format);
  const pollIntervalMs = options?.pollIntervalMs ?? 2_500;
  const timeoutMs = options?.timeoutMs ?? 4 * 60_000;
  const startedAt = Date.now();
  let notifiedGenerating = false;

  for (;;) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presentation_path: presentationPath, download: true }),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    const contentType = response.headers.get('content-type') || '';
    const isFile =
      response.ok &&
      (contentType.includes('pdf') ||
        contentType.includes('presentation') ||
        contentType.includes('octet-stream'));

    if (isFile) {
      const blob = await response.blob();
      if (blob.size === 0) throw new Error('Downloaded file is empty');
      return blob;
    }

    if (response.status === 202) {
      if (!notifiedGenerating) {
        notifiedGenerating = true;
        options?.onGenerating?.();
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for the ${format.toUpperCase()} to generate`);
      }
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, pollIntervalMs);
        options?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      });
      continue;
    }

    const text = await response.text().catch(() => '');
    let detail = response.statusText;
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      detail = String(json.error || json.detail || json.message || detail);
    } catch {
      if (text) detail = text;
    }
    throw new Error(
      `Failed to download ${format.toUpperCase()}: ${detail} (HTTP ${response.status})`,
    );
  }
}

export interface RuntimePresentationSlideMetadata {
  title: string;
  filename: string;
  file_path: string;
  preview_url: string;
  created_at: string;
}

export interface RuntimePresentationMetadata {
  presentation_name: string;
  title: string;
  description: string;
  /** Keyed by 1-based slide number, as strings — the runtime writes it that way. */
  slides: Record<string, RuntimePresentationSlideMetadata>;
  created_at: string;
  updated_at: string;
}

/**
 * Directory name the runtime creates for a presentation.
 *
 * The agent tool strips every character outside `[A-Za-z0-9-_]` and lowercases
 * the rest before creating `presentations/<name>/`. A reader that skips this
 * asks for a directory that does not exist.
 */
export function sanitizePresentationName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\-_]/g, '').toLowerCase();
}

/**
 * URL of a presentation's `metadata.json` on the session's static-file service.
 *
 * Returns `undefined` when there is nothing to point at — an empty name, or a
 * session whose runtime has no preview target yet (`hasPreviewTarget` false),
 * where `buildStaticFilePreviewUrl` would hand back a raw localhost URL that
 * cannot resolve from a browser.
 *
 * The cache-busting token is appended with `&`, not `?`: the static-file service
 * is reached at `/open?path=…`, so a second `?` would land inside the `path`
 * query value and ask for a file named `metadata.json?t=…`.
 */
export function buildPresentationMetadataUrl(
  presentationName: string,
  options: SubdomainUrlOptions,
  cacheBust: string | number = Date.now(),
): string | undefined {
  const directory = sanitizePresentationName(presentationName);
  if (!directory) return undefined;
  if (!hasPreviewTarget(options)) return undefined;
  const url = buildStaticFilePreviewUrl(`presentations/${directory}/metadata.json`, options);
  if (!url) return undefined;
  return `${url}&t=${encodeURIComponent(String(cacheBust))}`;
}

export type PresentationMetadataResult<T = RuntimePresentationMetadata> =
  | { status: 'ready'; metadata: T }
  | {
      status: 'not-ready';
      /** HTTP status when the request completed, `null` when it never did. */
      httpStatus: number | null;
      reason: string;
    };

export interface FetchPresentationMetadataOptions {
  signal?: AbortSignal;
  /** Defaults to `Date.now()`. */
  cacheBust?: string | number;
}

/**
 * Read a presentation's `metadata.json` from the session runtime.
 *
 * A presentation is written slide by slide, so "not there yet" is the normal
 * state a viewer polls through — it is returned as `status: 'not-ready'`, never
 * thrown. Only a caller-supplied abort propagates, because that is the caller
 * asking to stop. The caller owns the retry cadence.
 */
export async function fetchPresentationMetadata<T = RuntimePresentationMetadata>(
  presentationName: string,
  options: SubdomainUrlOptions,
  fetchOptions?: FetchPresentationMetadataOptions,
): Promise<PresentationMetadataResult<T>> {
  const url = buildPresentationMetadataUrl(presentationName, options, fetchOptions?.cacheBust);
  if (!url) {
    return {
      status: 'not-ready',
      httpStatus: null,
      reason: 'No presentation metadata URL for this session runtime yet',
    };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      cache: 'no-cache',
      headers: { 'Cache-Control': 'no-cache' },
      ...(fetchOptions?.signal ? { signal: fetchOptions.signal } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return {
      status: 'not-ready',
      httpStatus: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    return {
      status: 'not-ready',
      httpStatus: response.status,
      reason: `HTTP ${response.status}: ${response.statusText}`,
    };
  }

  const text = await response.text().catch(() => '');
  try {
    return { status: 'ready', metadata: JSON.parse(text) as T };
  } catch {
    // A 200 that is not JSON is an ingress/proxy page, not a presentation.
    return {
      status: 'not-ready',
      httpStatus: response.status,
      reason: 'Presentation metadata is not valid JSON yet',
    };
  }
}
