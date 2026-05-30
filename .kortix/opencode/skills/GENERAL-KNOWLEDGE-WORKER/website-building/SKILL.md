---
name: website-building
description: "Use for distinctive production-grade websites, landing pages, and interactive web experiences with strong design and QA discipline."
---

# Website Building

Build distinctive, production-grade websites where every site looks DIFFERENT. Every choice — type, color, motion, layout — must be derived from the subject matter. Run the palette generator (`bun run shared/generate-palette.ts "keywords"`) to create a unique color scheme for each project. NEVER reuse the same palette across sites.

**This skill covers everything for web projects.** Read the sub-files in this directory as needed based on your project type. For web applications, also read `skills/GENERAL-KNOWLEDGE-WORKER/website-building/webapp/SKILL.md`.

**Universal design principles** (color philosophy, default palette, font selection) are shared with other skills via `design-foundations`. This skill's shared files extend those foundations with web-specific implementation (CSS variables, responsive tokens, base stylesheets). You don't need to load `design-foundations` separately — the web-specific versions in `shared/` are comprehensive.

Use `read` with the full path, e.g. `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/01-design-tokens.md`

---

## Project Type Routing

**Step 1: Identify project type and load domain-specific guidance:**

| Project Type | Action | Examples |
|---|---|---|
| Informational sites | `read` `skills/GENERAL-KNOWLEDGE-WORKER/website-building/informational/informational.md` | Personal sites, portfolios, editorial/blogs, small business, landing pages |
| Web applications | `read skills/GENERAL-KNOWLEDGE-WORKER/website-building/webapp/SKILL.md` | SaaS products, dashboards, admin panels, e-commerce, brand experiences |
| Browser games | `read` `skills/GENERAL-KNOWLEDGE-WORKER/website-building/game/game.md` + `skills/GENERAL-KNOWLEDGE-WORKER/website-building/game/game-testing.md` | 2D Canvas games, Three.js/WebGL, HTML5 games, interactive 3D experiences |

**Step 2: Read shared files** — read `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/01-design-tokens.md` and `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/02-typography.md` first (mandatory for ALL project types, including webapp). These establish the Kortix design system defaults and typography rules that apply universally. For web applications and dashboards, skip files marked with `†` below — those contain implementation details pre-configured in the fullstack template.

If the user says just "website" or "site" with no detail, ask what type or default to informational.

---

## Sub-File Reference

### Shared (`shared/`) — Every project

| File | Covers | Load |
|---|---|---|
| `shared/01-design-tokens.md` | Type scale, spacing, Kortix palette, base.css | **Always** |
| `shared/02-typography.md` | Font selection, pairing, loading, blacklist | **Always** |
| `shared/04-layout.md` | Spatial composition, responsive, mobile-first | **Always** † |
| `shared/05-taste.md` | Skeleton loaders, empty/error states, polish | **Always** |
| `shared/08-standards.md` | Accessibility, performance, anti-patterns | **Always** |
| `shared/09-technical.md` | Project structure, sandbox, deploy, checklist | **Always** † |
| `shared/head-defaults.html` | Attribution block for `<head>` | **Always** † |
| `shared/03-motion.md` | Scroll animations, Motion library, GSAP SVG plugins, hover/cursor | When animated |
| `shared/06-css-and-tailwind.md` | Tailwind CSS v3, shadcn/ui, modern CSS | When using Tailwind |
| `shared/07-toolkit.md` | CDN libraries, React, Three.js, icons, maps, SVG patterns/filters, esm.sh | When choosing libs |
| `shared/10-charts-and-dataviz.md` | Chart.js, Recharts, D3, KPIs, sparklines | When data viz needed |
| `shared/11-web-technologies.md` | Framework versions, browser compatibility | When checking compat |
| `shared/12-playwright-interactive.md` | Persistent Playwright browser QA, screenshots, visual testing | When testing |
| `shared/19-backend.md` | FastAPI/Express/Flask servers, WebSocket, SSE, port forwarding | When backend needed |
| `shared/20-llm-api.md` | LLM/AI API integration reference | When site uses AI APIs |

All paths are relative to `skills/GENERAL-KNOWLEDGE-WORKER/website-building/`.

† **Skip for webapp and dashboards** — implementation details pre-configured in the fullstack template. Design-tokens and typography are NOT skipped — they provide the authoritative design system defaults and font selection guidance for all project types.

### Domain-Specific — Load one

| File | When to load |
|---|---|
| `read skills/GENERAL-KNOWLEDGE-WORKER/website-building/webapp/SKILL.md` | SaaS, dashboard, admin, e-commerce, brand experience (child skill with fullstack template) |
| `webapp/dashboards.md` | Dashboard or data-dense interface (companion to webapp) |
| `informational/informational.md` | Personal site, portfolio, editorial, small business, landing |
| `game/game.md` | Browser game, Three.js, WebGL, interactive 3D |
| `game/2d-canvas.md` | 2D Canvas game (companion to game.md) |
| `game/game-testing.md` | Any browser game — load alongside game.md |

**Interactive QA:** Read `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/12-playwright-interactive.md` for persistent browser automation with Playwright (screenshots, functional testing, visual QA). Required for game testing, useful for any complex site.

---

## Workflow

### Step 0: Load ALL mandatory files (do this FIRST, in parallel)

Read ALL of these in one batch — they are mandatory for every project:
```
read("skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/01-design-tokens.md")
read("skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/02-typography.md")
read("skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/04-layout.md")
read("skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/05-taste.md")
read("skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/08-standards.md")
```

Then load the domain-specific file (informational, webapp, or game) from Step 1 below.

### Step 1: Generate unique palette

Run the palette generator with keywords describing the subject:
```bash
bun run skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/generate-palette.ts "subject keywords here"
```
Pick the best harmony, customize if needed.

### Step 2: Design & Build

Build the site with the generated palette, following all the loaded design guidance.

### Step 3: Preview

Show via static server: `show(type: "url", url: "http://localhost:3211/open?path=/workspace/project/index.html")`

---

## Use Every Tool

- **Research first.** Search the web for reference sites, trends, and competitor examples before designing. Browse award-winning examples of the specific site type. Fetch any URLs the user provides.
- **Generate real assets — generously.** Generate images for heroes, section illustrations, editorial feature visuals, atmospheric backgrounds — not just one hero image. Every long page should have visual rhythm with generated images that match the site's art direction. No placeholders. Generate a custom SVG logo for every project (see below) — SVG is for logos only unless the user specifically requests SVG output. Save web reference images that inform direction.
- **Screenshot via Playwright.** Read `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/12-playwright-interactive.md` to screenshot at desktop (1280px+) and mobile (375px). Compare against references. This is mandatory, not optional. See Visual QA below.
- **Write production code directly.** HTML, CSS, JS, SVG. Use bash for build tools and file processing.

---

## SVG Logo Generation

Every project gets a custom inline SVG logo. Never substitute a styled text heading.

1. **Understand the brand** — purpose, tone, one defining word
2. **Write SVG directly** — geometric shapes, letterforms, or abstract marks. One memorable shape.
3. **Principles:** Geometric/minimal (Paul Rand, Vignelli). Works at 24px and 200px. Monochrome first — add color as enhancement. Use `currentColor` for dark/light mode.
4. **Implement inline** with `aria-label`, `viewBox`, `fill="none"`, `currentColor` strokes
5. **Generate a favicon** — simplified 32x32 version if needed

For SVG animation (DrawSVG, MorphSVG), see `shared/03-motion.md`. For SVG patterns/filters, see `shared/07-toolkit.md`.

---

## Visual QA Testing Process

Every deployment must pass visual QA. Screenshots are quality gates.

Read `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/12-playwright-interactive.md` for all visual QA. Playwright provides a persistent browser session for screenshots, interaction testing, and viewport verification.

**Cycle:** `Build → Playwright QA → Evaluate → Fix → Repeat → Deploy when ready`

### Stage 1: Page-by-Page QA
After building each page:
1. **Screenshot at desktop** (1280px+) and **mobile** (375px) via Playwright
2. **Evaluate critically:** Does it look professionally designed (not AI-generated)? Is typography distinctive? Is whitespace generous? Is there one clear visual hierarchy?
3. **Fix every issue before moving on.** No visual debt.

### Stage 2: Final QA (before publishing)
1. Screenshot every page at desktop and mobile
2. Check cross-page consistency (spacing, color, type treatment)
3. Verify dark mode (screenshot both themes for homepage minimum)
4. Check interactive states: hover, focus, active, loading, empty, error
5. Cold-open first impression test: does it feel polished and intentional?

**QA failures:** text overflow, inconsistent spacing, off-token colors, missing dark mode, squished mobile, generic AI look, placeholder content, missing logo.

---

## Step 1: Art Direction — Infer Before You Ask, Ask Before You Default

Every site should have a visual identity derived from its content. **Do not skip to the Kortix fallback palette.** The Kortix palette is a last resort for when both inference and asking have failed — not a convenient default.

1. **Infer from the subject.** A coffee roaster site → earthy browns, warm cream, hand-drawn feel. A fintech dashboard → cool slate, sharp sans-serif, data-dense. A children's learning app → bright primaries, rounded type, playful motion. The content itself tells you the palette, typography, and spacing before the user says a word.
2. **Check the Art Direction tables.** Each domain file (`informational.md`, `webapp/SKILL.md`, `game/game.md`) has an Art Direction table mapping site/product types to concept-driven directions and token starting points. Use these as a springboard.
3. **Derive the five pillars:** Color (warm/cool, accent from subject), Typography (serif/sans, display personality), Spacing (dense/generous), Motion (minimal/expressive), Imagery (photo/illustration/type-only).
4. **If the subject is genuinely ambiguous, ask** — "What mood are you going for?" and "Any reference sites?" One question is enough.
5. **Kortix fallback — only when inference AND asking yield nothing.** If the user has been asked and gave no direction, AND the subject matter gives no clear signal, then fall back to Kortix/Swiss defaults.

### The Fallback: Clean & Swiss (Last Resort)

When inference yielded no clear direction AND the user was asked but gave no style guidance, use defaults from `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/01-design-tokens.md` with:

- **Typography:** Satoshi or General Sans body (Fontshare — preferred), or Inter/DM Sans. Weight contrast over font contrast. 3-4 sizes max. Keep text compact — `--text-3xl`/`--text-hero` are for informational site heroes only.
- **Color:** Kortix palette. Neutral surfaces + one teal accent for CTAs only.
- **Layout:** Grid-aligned. Generous margins. Asymmetric where interesting.
- **Motion:** Minimal, functional. Smooth state transitions only.
- **Imagery:** Generate clean, relevant visuals. No stock photos.

### Art Direction — Avoid the AI Aesthetic

See `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/08-standards.md` for the full anti-patterns list.

---

## Step 2: Publish

Use real local preview commands first and only publish with the target project's actual deployment workflow. See `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/09-technical.md` for the recommended preview and delivery flow.

---

## Delivery

- Always verify the site locally first.
- Use `pty_spawn` for the preview or dev server.
- If the target repo already has a deployment workflow, use that exact workflow.
- If there is no established deploy target, deliver the files and a verified local preview instead of inventing a platform-specific deployment story.
