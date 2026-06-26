#!/usr/bin/env bun
/**
 * Presentation CLI — create, manage, validate, preview and export HTML slide decks.
 *
 * Usage: bun run presentation.ts <action> [args as JSON]
 *
 * Actions:
 *   create_slide        '{"presentation_name":"my-deck","slide_number":1,"slide_title":"Intro","content":"<div>...</div>","presentation_title":"My Deck"}'
 *   list_slides         '{"presentation_name":"my-deck"}'
 *   delete_slide        '{"presentation_name":"my-deck","slide_number":1}'
 *   list_presentations
 *   delete_presentation '{"presentation_name":"my-deck"}'
 *   validate_slide      '{"presentation_name":"my-deck","slide_number":1}'
 *   export_pdf          '{"presentation_name":"my-deck"}'
 *   export_pptx         '{"presentation_name":"my-deck"}'
 *   preview             '{"presentation_name":"my-deck"}'
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, rmSync, unlinkSync, statSync } from "fs";
import { resolve, join, dirname, extname } from "path";
import { execSync } from "child_process";

const PRESENTATIONS_DIR = "presentations";
const SKILL_DIR = dirname(new URL(import.meta.url).pathname);
const SCRIPTS_DIR = join(SKILL_DIR, "scripts");

// ── Types ──────────────────────────────────────────────────────────────────

interface SlideMetadata { title: string; filename: string; file_path: string; created_at: string; }
interface PresentationMetadata {
  presentation_name: string; title: string; description: string;
  slides: Record<string, SlideMetadata>; created_at: string; updated_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sanitizeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 80);
}

function ensurePresentationsDir(base: string): string {
  const dir = resolve(base, PRESENTATIONS_DIR);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "EACCES" || code === "EROFS") {
      const fallback = resolve(process.cwd(), PRESENTATIONS_DIR);
      mkdirSync(fallback, { recursive: true });
      return fallback;
    }
    throw err;
  }
  return dir;
}

function ensurePresentationDir(base: string, name: string): { safeName: string; path: string; presDir: string } {
  const safeName = sanitizeFilename(name);
  const presDir = ensurePresentationsDir(base);
  const path = join(presDir, safeName);
  mkdirSync(path, { recursive: true });
  return { safeName, path, presDir };
}

function loadMetadata(presentationPath: string): PresentationMetadata {
  const metaPath = join(presentationPath, "metadata.json");
  if (existsSync(metaPath)) return JSON.parse(readFileSync(metaPath, "utf-8"));
  return { presentation_name: "", title: "Presentation", description: "", slides: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}

function saveMetadata(presentationPath: string, metadata: PresentationMetadata): void {
  metadata.updated_at = new Date().toISOString();
  writeFileSync(join(presentationPath, "metadata.json"), JSON.stringify(metadata, null, 2));
}

function createSlideHtml(content: string, slideNumber: number, presentationTitle: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=1920, initial-scale=1.0">
    <title>${presentationTitle} - Slide ${slideNumber}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
    <script src="https://d3js.org/d3.v7.min.js" async></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@3.9.1" async></script>
    <style>
        * { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
        body { height: 1080px; width: 1920px; margin: 0; padding: 0; }
    </style>
</head>
<body>
    ${content}
</body>
</html>`;
}

function generateViewer(presPath: string, metadata: PresentationMetadata): void {
  const viewerTemplatePath = join(SKILL_DIR, "viewer.html");
  if (!existsSync(viewerTemplatePath)) return;
  const slides = Object.entries(metadata.slides)
    .map(([num, data]) => ({ number: parseInt(num), title: data.title || `Slide ${num}`, filename: data.filename }))
    .sort((a, b) => a.number - b.number);
  const presData = JSON.stringify({ title: metadata.title || metadata.presentation_name || "Presentation", slides });
  const template = readFileSync(viewerTemplatePath, "utf-8");
  writeFileSync(join(presPath, "viewer.html"), template.replace("{{TITLE}}", metadata.title || "Presentation").replace("{{PRESENTATION_DATA}}", presData));
}

function runPythonScript(script: string, args: string[], timeoutMs = 300_000): string {
  const isLinux = process.platform === "linux";
  const cmd = isLinux
    ? `python3 ${script} ${args.map(a => `"${a}"`).join(" ")}`
    : `uv run ${script} ${args.map(a => `"${a}"`).join(" ")}`;
  const env: Record<string, string | undefined> = { ...process.env };
  if (!isLinux) env.UV_CACHE_DIR = env.UV_CACHE_DIR ?? join(process.env.HOME ?? "/tmp", ".cache", "uv");
  try {
    return execSync(cmd, { cwd: SCRIPTS_DIR, timeout: timeoutMs, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env }).trim();
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const stdout = err.stdout?.trim() ?? "";
    if (stdout) { try { const p = JSON.parse(stdout); if (p.success === false) return stdout; } catch {} }
    return JSON.stringify({ success: false, error: err.stderr?.trim() || err.message || "Python script failed" });
  }
}

function out(data: unknown): void { console.log(JSON.stringify(data, null, 2)); }

// ── Actions ────────────────────────────────────────────────────────────────

function doCreateSlide(base: string, presentation_name: string, slide_number: number, slide_title: string, content: string, presentation_title: string) {
  if (!presentation_name) return out({ success: false, error: "presentation_name is required" });
  if (!slide_number || slide_number < 1) return out({ success: false, error: "slide_number must be >= 1" });
  if (!slide_title) return out({ success: false, error: "slide_title is required" });
  if (!content) return out({ success: false, error: "content is required" });

  const { safeName, path: presPath, presDir } = ensurePresentationDir(base, presentation_name);
  mkdirSync(join(presDir, "images"), { recursive: true });

  const metadata = loadMetadata(presPath);
  metadata.presentation_name = presentation_name;
  if (presentation_title !== "Presentation") metadata.title = presentation_title;

  const html = createSlideHtml(content, slide_number, presentation_title);
  const filename = `slide_${String(slide_number).padStart(2, "0")}.html`;
  writeFileSync(join(presPath, filename), html);

  const relPath = `${PRESENTATIONS_DIR}/${safeName}/${filename}`;
  metadata.slides[String(slide_number)] = { title: slide_title, filename, file_path: relPath, created_at: new Date().toISOString() };
  saveMetadata(presPath, metadata);
  generateViewer(presPath, metadata);

  out({ success: true, action: "create_slide", presentation_name, presentation_path: `${PRESENTATIONS_DIR}/${safeName}`, slide_number, slide_title, slide_file: relPath, total_slides: Object.keys(metadata.slides).length });
}

function doListSlides(base: string, presentation_name: string) {
  if (!presentation_name) return out({ success: false, error: "presentation_name is required" });
  const safeName = sanitizeFilename(presentation_name);
  const presPath = join(resolve(base, PRESENTATIONS_DIR), safeName);
  if (!existsSync(presPath)) return out({ success: true, presentation_name, slides: [], total_slides: 0 });
  const metadata = loadMetadata(presPath);
  const slides = Object.entries(metadata.slides).map(([num, data]) => ({ slide_number: parseInt(num), ...data })).sort((a, b) => a.slide_number - b.slide_number);
  out({ success: true, presentation_name, presentation_title: metadata.title, slides, total_slides: slides.length, presentation_path: `${PRESENTATIONS_DIR}/${safeName}` });
}

function doDeleteSlide(base: string, presentation_name: string, slide_number: number) {
  if (!presentation_name) return out({ success: false, error: "presentation_name is required" });
  if (!slide_number || slide_number < 1) return out({ success: false, error: "slide_number must be >= 1" });
  const safeName = sanitizeFilename(presentation_name);
  const presPath = join(resolve(base, PRESENTATIONS_DIR), safeName);
  if (!existsSync(presPath)) return out({ success: false, error: `Presentation '${presentation_name}' not found` });
  const metadata = loadMetadata(presPath);
  const key = String(slide_number);
  if (!metadata.slides[key]) return out({ success: false, error: `Slide ${slide_number} not found` });
  const slideInfo = metadata.slides[key];
  try { unlinkSync(join(presPath, slideInfo.filename)); } catch {}
  delete metadata.slides[key];
  saveMetadata(presPath, metadata);
  generateViewer(presPath, metadata);
  out({ success: true, action: "delete_slide", presentation_name, deleted_slide: slide_number, deleted_title: slideInfo.title, remaining_slides: Object.keys(metadata.slides).length });
}

function doListPresentations(base: string) {
  const presDir = resolve(base, PRESENTATIONS_DIR);
  if (!existsSync(presDir)) return out({ success: true, presentations: [], total_count: 0 });
  const presentations = readdirSync(presDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== "images")
    .map(d => { const meta = loadMetadata(join(presDir, d.name)); return { folder: d.name, title: meta.title || d.name, description: meta.description || "", total_slides: Object.keys(meta.slides).length, created_at: meta.created_at, updated_at: meta.updated_at }; });
  out({ success: true, presentations, total_count: presentations.length });
}

function doDeletePresentation(base: string, presentation_name: string) {
  if (!presentation_name) return out({ success: false, error: "presentation_name is required" });
  const safeName = sanitizeFilename(presentation_name);
  const presPath = join(resolve(base, PRESENTATIONS_DIR), safeName);
  if (!existsSync(presPath)) return out({ success: false, error: `Presentation '${presentation_name}' not found` });
  rmSync(presPath, { recursive: true, force: true });
  out({ success: true, action: "delete_presentation", presentation_name, deleted_path: `${PRESENTATIONS_DIR}/${safeName}` });
}

function doValidateSlide(base: string, presentation_name: string, slide_number: number) {
  if (!presentation_name) return out({ success: false, error: "presentation_name is required" });
  if (!slide_number || slide_number < 1) return out({ success: false, error: "slide_number must be >= 1" });
  const safeName = sanitizeFilename(presentation_name);
  const presPath = join(resolve(base, PRESENTATIONS_DIR), safeName);
  const metadata = loadMetadata(presPath);
  const key = String(slide_number);
  if (!metadata.slides[key]) return out({ success: false, error: `Slide ${slide_number} not found` });
  const slidePath = join(resolve(base), metadata.slides[key].file_path);
  if (!existsSync(slidePath)) return out({ success: false, error: `Slide file not found: ${slidePath}` });
  const raw = runPythonScript("validate_slide.py", [slidePath]);
  try { out({ ...JSON.parse(raw), action: "validate_slide", presentation_name, slide_number }); } catch { out({ success: false, error: raw }); }
}

function doExportPdf(base: string, presentation_name: string) {
  if (!presentation_name) return out({ success: false, error: "presentation_name is required" });
  const safeName = sanitizeFilename(presentation_name);
  const presPath = join(resolve(base, PRESENTATIONS_DIR), safeName);
  if (!existsSync(presPath)) return out({ success: false, error: `Presentation '${presentation_name}' not found` });
  const outPath = join(presPath, `${safeName}.pdf`);
  const raw = runPythonScript("convert_pdf.py", [presPath, outPath]);
  try {
    const result = JSON.parse(raw);
    out(result.success ? { ...result, action: "export_pdf", presentation_name, relative_path: `${PRESENTATIONS_DIR}/${safeName}/${safeName}.pdf` } : result);
  } catch { out({ success: false, error: raw }); }
}

function doExportPptx(base: string, presentation_name: string) {
  if (!presentation_name) return out({ success: false, error: "presentation_name is required" });
  const safeName = sanitizeFilename(presentation_name);
  const presPath = join(resolve(base, PRESENTATIONS_DIR), safeName);
  if (!existsSync(presPath)) return out({ success: false, error: `Presentation '${presentation_name}' not found` });
  const outPath = join(presPath, `${safeName}.pptx`);
  const raw = runPythonScript("convert_pptx.py", [presPath, outPath]);
  try {
    const result = JSON.parse(raw);
    out(result.success ? { ...result, action: "export_pptx", presentation_name, relative_path: `${PRESENTATIONS_DIR}/${safeName}/${safeName}.pptx` } : result);
  } catch { out({ success: false, error: raw }); }
}

function doPreview(base: string, presentation_name: string) {
  if (!presentation_name) return out({ success: false, error: "presentation_name is required" });
  const safeName = sanitizeFilename(presentation_name);
  const presPath = join(resolve(base, PRESENTATIONS_DIR), safeName);
  if (!existsSync(presPath)) return out({ success: false, error: `Presentation '${presentation_name}' not found` });
  generateViewer(presPath, loadMetadata(presPath));
  out({
    success: true, action: "preview", presentation_name,
    viewer_file: `${PRESENTATIONS_DIR}/${safeName}/viewer.html`,
    message: `Viewer generated at ${PRESENTATIONS_DIR}/${safeName}/viewer.html. To serve it, run: bun run "$SCRIPT" serve '{"presentation_name":"${safeName}"}'`,
  });
}

// ── Serve (on-demand viewer server) ───────────────────────────────────────

const SERVE_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function serveMime(filePath: string): string {
  return SERVE_MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
}

function serveFile(filePath: string): Response {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return new Response("Not found: " + filePath, { status: 404 });
  }
  const data = readFileSync(filePath);
  return new Response(data, {
    headers: { "Content-Type": serveMime(filePath), "Cache-Control": "no-cache" },
  });
}

function buildViewerHtml(presDir: string, metadata: PresentationMetadata): string {
  const viewerTemplatePath = join(SKILL_DIR, "viewer.html");
  if (!existsSync(viewerTemplatePath)) {
    return "<html><body><p>viewer.html template not found</p></body></html>";
  }
  const slides = Object.entries(metadata.slides)
    .map(([num, data]) => ({ number: parseInt(num), title: data.title || `Slide ${num}`, filename: data.filename || `slide_${String(num).padStart(2, "0")}.html` }))
    .sort((a, b) => a.number - b.number);
  const presData = JSON.stringify({ title: metadata.title || metadata.presentation_name || "Presentation", slides });
  const template = readFileSync(viewerTemplatePath, "utf-8");
  return template.replace("{{TITLE}}", metadata.title || "Presentation").replace("{{PRESENTATION_DATA}}", presData);
}

function listAllPresentations(presRoot: string): Array<{ name: string; title: string; total_slides: number }> {
  if (!existsSync(presRoot)) return [];
  return readdirSync(presRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== "images")
    .map(d => {
      const meta = loadMetadata(join(presRoot, d.name));
      return { name: d.name, title: meta.title || d.name, total_slides: Object.keys(meta.slides || {}).length };
    });
}

function buildIndexHtml(pres: Array<{ name: string; title: string; total_slides: number }>): string {
  const items = pres.map(p =>
    `<li><a href="/presentations/${p.name}/"><span>${p.title}</span><span class="count">${p.total_slides} slides</span></a></li>`
  ).join("");
  const empty = pres.length === 0 ? '<p class="empty">No presentations yet. Create one with the presentation CLI.</p>' : "";
  return `<!DOCTYPE html><html><head><title>Presentations</title>
<style>body{font-family:sans-serif;padding:2rem;max-width:800px;margin:0 auto}
h1{font-size:1.5rem;margin-bottom:1.5rem}ul{list-style:none;padding:0}li{margin:0.5rem 0}
a{display:flex;align-items:center;gap:0.5rem;padding:0.75rem 1rem;border:1px solid #e5e7eb;border-radius:0.5rem;text-decoration:none;color:inherit}
a:hover{background:#f9fafb}.count{font-size:0.75rem;color:#6b7280;margin-left:auto}.empty{color:#6b7280}
</style></head><body><h1>Presentations (${pres.length})</h1><ul>${items}</ul>${empty}</body></html>`;
}

function doServe(base: string, port: number) {
  const presRoot = resolve(base, PRESENTATIONS_DIR);
  const corsHeaders = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" };

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch(req) {
      const url = new URL(req.url);
      const pathname = decodeURIComponent(url.pathname);

      // Index
      if (pathname === "/" || pathname === "/index.html") {
        const pres = listAllPresentations(presRoot);
        return new Response(buildIndexHtml(pres), { headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders } });
      }

      // /presentations/<name>[/...]
      const presMatch = pathname.match(/^\/presentations\/([^/]+)\/?(.*)$/);
      if (presMatch) {
        const presName = presMatch[1];
        if (!presName) {
          return new Response("Presentation not found", { status: 404, headers: corsHeaders });
        }
        const rest = presMatch[2] || "";
        const presDir = join(presRoot, presName);

        if (!existsSync(presDir)) {
          return new Response("Presentation not found: " + presName, { status: 404, headers: corsHeaders });
        }

        const metadata = loadMetadata(presDir);

        // Viewer
        if (rest === "" || rest === "viewer" || rest === "viewer.html" || rest === "index.html") {
          const html = buildViewerHtml(presDir, metadata);
          return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders } });
        }

        // ../images/ references from within slide iframes
        if (rest.startsWith("../images/") || rest.startsWith("%2E%2E/images/")) {
          const imgName = rest.replace(/^(\.\.\/|%2E%2E\/)images\//, "");
          return serveFile(join(presRoot, "images", imgName));
        }

        // images/ relative to presentation dir
        if (rest.startsWith("images/")) {
          return serveFile(join(presRoot, "images", rest.slice("images/".length)));
        }

        // Any file inside the presentation dir
        return serveFile(join(presDir, rest));
      }

      // /images/<name> — shared images
      if (pathname.startsWith("/images/")) {
        return serveFile(join(presRoot, "images", pathname.slice("/images/".length)));
      }

      return new Response("Not found", { status: 404, headers: corsHeaders });
    },
  });

  const pres = listAllPresentations(presRoot);
  console.log(`\n  Presentation Viewer`);
  console.log(`  http://localhost:${server.port}\n`);
  console.log(`  Serving ${pres.length} presentation(s) from ${presRoot}`);
  pres.forEach(p => console.log(`  → http://localhost:${server.port}/presentations/${p.name}/  (${p.total_slides} slides)`));
  console.log(`\n  Press Ctrl+C to stop\n`);

  // Output JSON for programmatic consumption
  out({
    success: true,
    action: "serve",
    port: server.port,
    url: `http://localhost:${server.port}`,
    presentations: pres.map(p => ({ name: p.name, url: `http://localhost:${server.port}/presentations/${p.name}/`, total_slides: p.total_slides })),
    message: `Viewer running at http://localhost:${server.port}`,
  });
}

// ── Dispatch ───────────────────────────────────────────────────────────────

const [action, rawArgs] = process.argv.slice(2);
const args = rawArgs ? JSON.parse(rawArgs) : {};
const base = args.output_dir ?? process.cwd();

switch (action) {
  case "create_slide":        doCreateSlide(base, args.presentation_name ?? "", args.slide_number ?? 0, args.slide_title ?? "", args.content ?? "", args.presentation_title ?? "Presentation"); break;
  case "list_slides":         doListSlides(base, args.presentation_name ?? ""); break;
  case "delete_slide":        doDeleteSlide(base, args.presentation_name ?? "", args.slide_number ?? 0); break;
  case "list_presentations":  doListPresentations(base); break;
  case "delete_presentation": doDeletePresentation(base, args.presentation_name ?? ""); break;
  case "validate_slide":      doValidateSlide(base, args.presentation_name ?? "", args.slide_number ?? 0); break;
  case "export_pdf":          doExportPdf(base, args.presentation_name ?? ""); break;
  case "export_pptx":         doExportPptx(base, args.presentation_name ?? ""); break;
  case "preview":             doPreview(base, args.presentation_name ?? ""); break;
  case "serve":               doServe(base, parseInt(args.port ?? process.env.PORT ?? "3210")); break;
  default:
    console.error(`Unknown action: ${action}. Use: create_slide | list_slides | delete_slide | list_presentations | delete_presentation | validate_slide | export_pdf | export_pptx | preview | serve`);
    process.exit(1);
}
