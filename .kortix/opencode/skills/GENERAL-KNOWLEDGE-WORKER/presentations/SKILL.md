---
name: presentations
description: "Create, manage, validate, preview, and export HTML presentation slides (1920x1080). Load this skill when you need to build a slide deck, export to PDF/PPTX, or preview slides in a browser."
---

# Presentations

1920x1080 HTML slide decks. Inter font, D3.js, and Chart.js pre-loaded.

```
SCRIPT=~/.opencode/skills/GENERAL-KNOWLEDGE-WORKER/presentations/presentation.ts
```

## Commands

```bash
# Create a slide (content = HTML body only, no html/head/body tags)
bun run "$SCRIPT" create_slide '{"presentation_name":"my-deck","slide_number":1,"slide_title":"Intro","content":"<div style=\"...\">...</div>","presentation_title":"My Deck"}'

# List slides
bun run "$SCRIPT" list_slides '{"presentation_name":"my-deck"}'

# Delete a slide
bun run "$SCRIPT" delete_slide '{"presentation_name":"my-deck","slide_number":2}'

# List all presentations
bun run "$SCRIPT" list_presentations

# Delete a presentation
bun run "$SCRIPT" delete_presentation '{"presentation_name":"my-deck"}'

# Validate dimensions (Playwright)
bun run "$SCRIPT" validate_slide '{"presentation_name":"my-deck","slide_number":1}'

# Export to PDF
bun run "$SCRIPT" export_pdf '{"presentation_name":"my-deck"}'

# Export to PPTX
bun run "$SCRIPT" export_pptx '{"presentation_name":"my-deck"}'

# Generate viewer HTML (no server)
bun run "$SCRIPT" preview '{"presentation_name":"my-deck"}'

# Start on-demand viewer server (port 3210 by default)
bun run "$SCRIPT" serve '{"port":3210}'
```

## Viewer Server

The viewer is **not** a persistent background service. Start it on-demand with the `serve` action when you need to preview slides:

```bash
bun run "$SCRIPT" serve '{"port":3210}'
```

This starts a Bun server on port 3210 that serves all presentations under the `presentations/` directory. When you need it to keep running, launch the same command in `pty_spawn`.

URL scheme:
- `http://localhost:3210/` — index listing all presentations
- `http://localhost:3210/presentations/<name>/` — viewer for that deck
- `http://localhost:3210/presentations/<name>/slide_01.html` — raw slide file

After starting the server, show the URL to the user via `show`:
```
show(action="show", type="url", url="http://localhost:3210/presentations/<name>/", title="Slide Preview")
```

## Slide HTML Rules

- `content` is the `<body>` content only — wrapper injected automatically
- Canvas: 1920×1080px, `box-sizing: border-box`, max 40px padding
- Inter pre-loaded. D3.js v7 + Chart.js 3.9.1 loaded async
- Wrap Chart.js init in `window.addEventListener('load', () => { ... })`
- Images → `presentations/images/` → reference as `../images/filename`

## Layout Patterns

**Title slide:**
```html
<div style="width:1920px;height:1080px;background:linear-gradient(135deg,#1e1b4b,#312e81);
     color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;
     box-sizing:border-box;padding:100px;text-align:center;">
  <div style="font-size:24px;color:#a5b4fc;letter-spacing:4px;text-transform:uppercase;margin-bottom:32px;">SUBTITLE</div>
  <h1 style="font-size:80px;font-weight:800;margin:0;line-height:1.1;">Title</h1>
</div>
```

**Two column:**
```html
<div style="width:1920px;height:1080px;background:#0f172a;color:#f8fafc;
     display:grid;grid-template-columns:1fr 1fr;gap:80px;
     box-sizing:border-box;padding:80px;align-items:center;">
  <div><!-- left --></div><div><!-- right --></div>
</div>
```

**Typography:** Title 64–80px/700+, Subtitle 36–48px, Body 28–36px, min 18px

## Workflow

```
create_slide × N → validate_slide → serve → show viewer URL → export_pdf / export_pptx
```
