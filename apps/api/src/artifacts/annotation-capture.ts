import {
  ARTIFACT_ANNOTATION_LIMITS as limits,
  type ArtifactAnnotationCaptureFailure,
  type ArtifactAnnotationRect,
} from "@kortix/shared/artifact-annotations";

export class ArtifactCaptureError extends Error {
  constructor(readonly reason: ArtifactAnnotationCaptureFailure) {
    super(reason);
    this.name = "ArtifactCaptureError";
  }
}
const excluded =
  'head,script,style,noscript,template,iframe,object,embed,input,textarea,select,[contenteditable],[hidden],[inert],[aria-hidden="true"],[data-kortix-annotation-overlay]';
function check(signal: AbortSignal) {
  if (signal.aborted)
    throw new ArtifactCaptureError(
      ["stale", "timeout"].includes(signal.reason)
        ? signal.reason
        : "cancelled",
    );
}
function fail(error: unknown, signal: AbortSignal): never {
  check(signal);
  if (error instanceof ArtifactCaptureError) throw error;
  throw new ArtifactCaptureError(
    error instanceof DOMException && error.name === "SecurityError"
      ? "tainted"
      : "unavailable",
  );
}

export async function buildArtifactCaptureSvg(
  document: Document,
  rect: ArtifactAnnotationRect,
  signal: AbortSignal,
): Promise<{ svg: string; width: number; height: number }> {
  check(signal);
  if (
    !document.body ||
    !Object.values(rect).every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    throw new ArtifactCaptureError("unavailable");
  const view = document.defaultView!;
  let nodes = 0;
  let units = 0;
  let assets = 0;
  const fonts = new Set<string>();
  const cache = new Map<string, Promise<string>>();
  const spend = (value: string) => {
    units += new TextEncoder().encode(value).length;
    if (units > limits.captureSvgBytes)
      throw new ArtifactCaptureError("too_large");
    return value;
  };
  const raster = (source: HTMLImageElement | HTMLCanvasElement): string => {
    const image = source.tagName === "IMG";
    const width = image
      ? (source as HTMLImageElement).naturalWidth
      : source.width;
    const height = image
      ? (source as HTMLImageElement).naturalHeight
      : source.height;
    if (!width || !height) throw new ArtifactCaptureError("unavailable");
    const scale = Math.min(
      1,
      limits.captureEdge / width,
      limits.captureEdge / height,
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    try {
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new ArtifactCaptureError("unavailable");
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      return spend(canvas.toDataURL("image/png"));
    } catch (error) {
      return fail(error, signal);
    }
  };
  const resource = (raw: string, base: string): Promise<string> => {
    const url = new URL(raw, base).href;
    let pending = cache.get(url);
    if (!pending) {
      pending = (async () => {
        check(signal);
        if (!/^(https?:|data:)/.test(url))
          throw new ArtifactCaptureError("unavailable");
        const response = await view.fetch(url, { credentials: "omit", signal });
        if (!response.ok || !response.body)
          throw new ArtifactCaptureError("unavailable");
        const reader = response.body.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            assets += part.value.length;
            if (assets > limits.captureSvgBytes)
              throw new ArtifactCaptureError("too_large");
            parts.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const part of parts) {
          bytes.set(part, at);
          at += part.length;
        }
        let text = "";
        for (let start = 0; start < bytes.length; start += 8192)
          text += String.fromCharCode(...bytes.subarray(start, start + 8192));
        return spend(
          `data:${response.headers.get("content-type")?.split(";")[0] || "application/octet-stream"};base64,${view.btoa(text)}`,
        );
      })();
      cache.set(url, pending);
    }
    return pending;
  };
  const inlineUrls = async (value: string, base: string) => {
    const matches = [...value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)];
    for (const match of matches) {
      const url = match[1]!;
      if (url.startsWith("#")) continue;
      value = value.replace(match[0], `url("${await resource(url, base)}")`);
    }
    return value;
  };
  const clone = async (source: Node): Promise<Node | null> => {
    check(signal);
    if (++nodes > limits.elements) throw new ArtifactCaptureError("too_large");
    if (source.nodeType === 3)
      return document.createTextNode(spend(source.textContent ?? ""));
    if (source.nodeType !== 1) return null;
    const element = source as HTMLElement;
    if (element.matches(excluded)) return null;
    const computed = view.getComputedStyle(element);
    if (
      computed.display === "none" ||
      computed.visibility === "hidden" ||
      computed.visibility === "collapse"
    )
      return null;
    if (computed.position === "fixed" || computed.position === "sticky") {
      const box = element.getBoundingClientRect();
      const x = box.x + view.scrollX;
      const y = box.y + view.scrollY;
      if (
        box.width > 0 &&
        box.height > 0 &&
        x < rect.x + rect.width &&
        y < rect.y + rect.height &&
        x + box.width > rect.x &&
        y + box.height > rect.y
      )
        throw new ArtifactCaptureError("unavailable");
      if (computed.position === "fixed") return null;
      const placeholder = document.createElement("div");
      placeholder.setAttribute(
        "style",
        spend(
          Array.from(computed)
            .filter((key) => !/url\s*\(/i.test(computed.getPropertyValue(key)))
            .map((key) => `${key}:${computed.getPropertyValue(key)}`)
            .join(";") + ";opacity:0",
        ),
      );
      return placeholder;
    }
    if (element.tagName === "VIDEO")
      throw new ArtifactCaptureError("unavailable");
    let target: Element;
    if (element.tagName === "IMG" || element.tagName === "CANVAS") {
      target = document.createElement("img");
      target.setAttribute(
        "src",
        raster(element as unknown as HTMLImageElement),
      );
    } else target = element.cloneNode(false) as Element;
    for (const attribute of Array.from(target.attributes)) {
      const link = attribute.name === "href" || attribute.name === "xlink:href";
      if (
        link &&
        element.namespaceURI === "http://www.w3.org/2000/svg" &&
        ["use", "image"].includes(element.localName)
      ) {
        if (!attribute.value.startsWith("#"))
          throw new ArtifactCaptureError("unavailable");
        continue;
      }
      if (
        /^on/i.test(attribute.name) ||
        (["src", "srcset", "href", "xlink:href"].includes(attribute.name) &&
          element.tagName !== "IMG")
      )
        target.removeAttribute(attribute.name);
    }
    const styles: string[] = [];
    for (const key of Array.from(computed)) {
      if (
        key === "cursor" ||
        key.startsWith("animation") ||
        key.startsWith("transition")
      )
        continue;
      const value = await inlineUrls(
        computed.getPropertyValue(key),
        document.baseURI,
      );
      styles.push(`${key}:${value}`);
    }
    target.setAttribute("style", spend(styles.join(";")));
    for (const family of computed.fontFamily.split(","))
      fonts.add(
        family
          .trim()
          .replace(/^['"]|['"]$/g, "")
          .toLowerCase(),
      );
    if (element.tagName !== "IMG" && element.tagName !== "CANVAS")
      for (const child of Array.from(element.childNodes)) {
        const copy = await clone(child);
        if (copy) target.append(copy);
      }
    for (const pseudo of ["::before", "::after"]) {
      const style = view.getComputedStyle(element, pseudo);
      const content = style.content;
      if (
        !content ||
        content === "none" ||
        content === "normal" ||
        content === '""'
      )
        continue;
      if (!/^"[^"\\]*"$/.test(content))
        throw new ArtifactCaptureError("unavailable");
      const span = document.createElement("span");
      span.textContent = content.slice(1, -1);
      const values: string[] = [];
      for (const key of Array.from(style))
        values.push(
          `${key}:${await inlineUrls(style.getPropertyValue(key), document.baseURI)}`,
        );
      span.setAttribute("style", spend(values.join(";")));
      pseudo === "::before" ? target.prepend(span) : target.append(span);
    }
    return target;
  };
  try {
    const root = (await clone(document.documentElement)) as HTMLElement | null;
    if (!root) throw new ArtifactCaptureError("unavailable");
    root.style.minHeight = `${Math.max(view.innerHeight, document.documentElement.scrollHeight)}px`;
    const fontRules: string[] = [];
    const inspect = async (rules: CSSRuleList, base: string): Promise<void> => {
      for (const rule of Array.from(rules)) {
        if (rule.type === 5) {
          const face = rule as CSSFontFaceRule;
          if (
            fonts.has(
              face.style.fontFamily.replace(/^['"]|['"]$/g, "").toLowerCase(),
            )
          )
            fontRules.push(await inlineUrls(face.cssText, base));
        } else if ("cssRules" in rule)
          await inspect((rule as CSSGroupingRule).cssRules, base);
      }
    };
    for (const sheet of Array.from(document.styleSheets))
      await inspect(sheet.cssRules, sheet.href || document.baseURI);
    const scale = Math.min(
      1,
      limits.captureEdge / rect.width,
      limits.captureEdge / rect.height,
    );
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    const markup = new view.XMLSerializer().serializeToString(root);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${rect.x} ${rect.y} ${rect.width} ${rect.height}"><foreignObject x="0" y="0" width="${Math.max(view.innerWidth, document.documentElement.scrollWidth)}" height="${Math.max(document.documentElement.scrollHeight, rect.y + rect.height)}"><style>${fontRules.join("\n")}</style>${markup}</foreignObject></svg>`;
    spend(svg);
    check(signal);
    return { svg, width, height };
  } catch (error) {
    return fail(error, signal);
  }
}

export async function captureArtifactRegion(
  document: Document,
  rect: ArtifactAnnotationRect,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const value = await buildArtifactCaptureSvg(document, rect, signal);
  const view = document.defaultView!;
  const image = new view.Image();
  const cancel = () => {
    image.src = "";
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value.svg)}`;
    await image.decode();
    check(signal);
    const canvas = document.createElement("canvas");
    canvas.width = value.width;
    canvas.height = value.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ArtifactCaptureError("unavailable");
    ctx.drawImage(image, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    check(signal);
    if (!blob) throw new ArtifactCaptureError("unavailable");
    if (blob.size > limits.captureBytes)
      throw new ArtifactCaptureError("too_large");
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: value.width,
      height: value.height,
    };
  } catch (error) {
    return fail(error, signal);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
