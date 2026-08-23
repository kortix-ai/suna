import { ObjectUrlCache } from "@/lib/object-url-cache"
import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models"

const PDFIUM_WASM_PATH = "/pdfium/pdfium.wasm"

// The pdfium engine runs inside a `blob:`-URL Web Worker. A root-relative path
// (e.g. "/pdfium/pdfium.wasm") has no usable base inside that worker and throws
// on `fetch`, so the URL must be absolutized against the document origin before
// it is handed to the worker.
function resolvePdfiumWasmUrl(): string {
  if (typeof window === "undefined") return PDFIUM_WASM_PATH
  return new URL(PDFIUM_WASM_PATH, window.location.origin).href
}

let sharedEnginePromise: Promise<PdfEngine> | null = null
const pdfDocumentCache = new Map<string, Promise<PdfDocumentObject>>()
/**
 * Rendered page thumbnails, BOUNDED and revoked on eviction.
 *
 * This was an uncapped `Map<string, Promise<string|null>>`, so every page of
 * every PDF a session ever previewed kept its object URL — and the blob behind
 * it — alive for the tab's lifetime. The in-flight map below still dedupes
 * concurrent renders of the same page; it just stops being the permanent home
 * for the result.
 */
const thumbnailUrlCache = new ObjectUrlCache(48)
/** Renders currently in flight, so two callers share one decode. Cleared as
 *  soon as the render settles — a resolved entry lives in the bounded cache. */
const thumbnailInFlight = new Map<string, Promise<string | null>>()

export function loadSharedPdfEngine() {
  sharedEnginePromise ??= import("@embedpdf/engines/pdfium-worker-engine").then(
    ({ createPdfiumEngine }) => createPdfiumEngine(resolvePdfiumWasmUrl(), {})
  )

  return sharedEnginePromise
}

export async function loadPdfDocument(url: string) {
  let documentPromise = pdfDocumentCache.get(url)

  if (!documentPromise) {
    documentPromise = loadSharedPdfEngine().then((engine) =>
      engine
        .openDocumentUrl(
          { id: url, url },
          { mode: url.startsWith("blob:") ? "full-fetch" : "auto" }
        )
        .toPromise()
    )
    pdfDocumentCache.set(url, documentPromise)
  }

  return documentPromise
}

export async function getPdfPageCount(url: string) {
  return (await loadPdfDocument(url)).pageCount
}

export function renderPdfThumbnailUrl({
  dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
  pageIndex,
  url,
  width,
}: {
  dpr?: number
  pageIndex: number
  url: string
  width: number
}) {
  const cacheKey = `${url}#${pageIndex}@${width}x${dpr}`
  const cached = thumbnailUrlCache.get(cacheKey)
  if (cached !== undefined) return cached

  let thumbnailPromise = thumbnailInFlight.get(cacheKey)

  if (!thumbnailPromise) {
    thumbnailPromise = (async () => {
      const [engine, document] = await Promise.all([
        loadSharedPdfEngine(),
        loadPdfDocument(url),
      ])
      const page = document.pages[pageIndex]

      if (!page) return null

      const blob = await engine
        .renderThumbnail(document, page, {
          dpr,
          imageType: "image/png",
          scaleFactor: width / page.size.width,
          withAnnotations: true,
        })
        .toPromise()

      const objectUrl = URL.createObjectURL(blob)
      thumbnailUrlCache.set(cacheKey, objectUrl)
      return objectUrl
    })()
    thumbnailInFlight.set(cacheKey, thumbnailPromise)
    // Settled is settled: the result (or the failure) leaves the in-flight map
    // either way, so a failed render is retried rather than remembered forever.
    void thumbnailPromise.finally(() => {
      if (thumbnailInFlight.get(cacheKey) === thumbnailPromise) {
        thumbnailInFlight.delete(cacheKey)
      }
    })
  }

  return thumbnailPromise
}
