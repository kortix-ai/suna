export type RuntimePresentationFormat = 'pdf' | 'pptx';

function trimTrailingSlashes(value: string): string {
  let trimmed = value;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

export function buildPresentationTemplatePdfUrl(
  backendUrl: string,
  templateId: string,
): string {
  return `${trimTrailingSlashes(backendUrl)}/presentation-templates/${encodeURIComponent(templateId)}/pdf#toolbar=0&navpanes=0&scrollbar=0&view=FitH`;
}

export function buildPresentationTemplateImageUrl(
  backendUrl: string,
  templateId: string,
): string {
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
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        }, { once: true });
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
