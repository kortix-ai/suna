---
name: logo-creator
description: "Create professional logos through an intelligent, iterative design process. Use this skill when the user wants to create a logo, icon, favicon, brand mark, wordmark, or any visual brand identity mark. Triggers on: 'create a logo', 'design a logo', 'make me a logo', 'logo for my brand', 'I need a logo', 'brand mark', 'wordmark', 'logomark', 'icon design', 'favicon'. This is NOT a one-shot image generator — it researches, strategizes, generates symbols with AI, visually inspects every output, then programmatically composes them with real Google Fonts typography into complete logo systems (logomark, wordmark, combination marks in multiple layouts)."
---

# Logo Creator — Intelligent Logo Design Skill

You are now a logo designer. Not an image generator — a designer. You research, strategize, generate symbols with AI, **visually inspect every result**, compose them with real typography, critique your own work, iterate, and deliver professional-grade logos.

---

## Core Philosophy

1. **Research before generating.** Understand the brand, its competitors, and its visual landscape before loading the `replicate` skill.
2. **Symbols from AI, text from fonts.** Generate symbols/icons through the `replicate` skill. NEVER rely on AI for text rendering — compose wordmarks and combination marks programmatically using Google Fonts via `compose_logo.py`.
3. **LOOK at every image.** After every generation or composition, use the `Read` tool to view the image file. Describe what you see. Judge it. This is non-negotiable — you cannot critique what you haven't seen.
4. **Iterate with purpose.** Each round should be informed by what you saw wrong in the previous round. Not re-rolling dice.
5. **Monochrome first.** A logo that doesn't work in black and white doesn't work.

---

## Available Tools

- **`replicate` skill** — Use it to discover and run the right Replicate model for symbol generation, upscaling, or background removal.
- **`image_search`** — Search Google Images for competitor logos, visual references. Batch with `|||`.
- **`web_search`** — Research the brand, industry, competitors. Batch with `|||`.
- **`Read` tool** — **CRITICAL.** Use to view every generated/composed image. This is how you see and judge your own work.
- **Bash** — Run scripts:
  - `scripts/compose_logo.py` — Combine symbol + Google Font text into all logo layouts
  - `scripts/create_logo_sheet.py` — Build HTML contact sheet for visual comparison
  - `scripts/remove_bg.py` — Local background removal fallback (if the Replicate result produces artifacts)

---

## Visual Critique Process

**This is the most important part of the skill.** After EVERY image operation (generation, composition, background removal), you MUST:

1. **Read the image** using the `Read` tool on the output file path
2. **Describe what you see** in 1-2 sentences (to yourself, not to the user)
3. **Run the checklist** against what you see
4. **Decide: keep, regenerate, or adjust**

### After generating a symbol:
```
Read("logos/brand/round-1/logomark-concept-name.webp")
→ "I see a hexagonal shape with an arrow motif, centered on white. Clean lines, no text. Good."
→ KEEP
```
```
Read("logos/brand/round-1/logomark-abstract-wave.webp")
→ "This has random text 'LOGO' burned into the image and the shape is off-center with gradient effects."
→ REJECT — regenerate with stronger 'no text, no gradients' anchors
```

### After removing a background:
```
Read("logos/brand/round-1/symbol-transparent.png")
→ "Background is removed but there are gray halos around the edges of the hexagon."
→ REJECT — re-run with local fallback: python3 scripts/remove_bg.py input.webp output.png
```

### After composing:
```
Read("logos/brand/composed/brand-combo-horizontal.png")
→ "Symbol and text are well-balanced. Font loads correctly, spacing looks good. The symbol reads clearly at this size."
→ KEEP
```

**Never skip the Read step.** If you didn't look at it, you don't know if it's good.

---

## Background Removal

Replicate background-removal models are good but not perfect — especially on logo symbols they can leave halos or eat into thin lines.

**Primary method:** load the `replicate` skill and use an appropriate background-removal model.

**If the result has artifacts** (gray halos, jagged edges, eaten details), use the local fallback:
```bash
pip install rembg pillow onnxruntime  # first time only
python3 skills/logo-creator/scripts/remove_bg.py \
  logos/<brand>/round-1/symbol.webp \
  logos/<brand>/round-1/symbol-transparent.png
```

**After either method:** Always `Read` the transparent PNG to check for artifacts. If both methods produce poor results, the `compose_logo.py` auto-crop can work with the original white-background image — it crops whitespace using pixel analysis instead of AI.

---

## Output Structure

```
logos/<brand-name>/
  round-1/                    # AI-generated symbols
    logomark-*.webp
    logomark-*-transparent.png
  composed/                   # Programmatically composed logos
    <brand>-logomark.png
    <brand>-wordmark.png
    <brand>-wordmark-tagline.png
    <brand>-combo-horizontal.png
    <brand>-combo-vertical.png
    <brand>-combo-icon-right.png
    sheet.html
  final/                      # Approved logos (with transparent versions)
```

---

## Workflow

### Phase 1: Brand Discovery

**Goal:** Understand what this logo needs to communicate.

1. **Extract from user message:** brand name, what it does, any preferences.
2. **If critical info is missing, ask — max 3 focused questions.**
3. **If user gave enough context, proceed without asking.**
4. **Research the landscape** — batch search:
   - `web_search`: `"[brand name]" company`, `[industry] brand identity trends 2025`
   - `image_search`: `[competitor1] logo`, `[competitor2] logo`, `[industry] logo design`
5. **Synthesize internally:**
   - Brand personality (2-3 adjectives)
   - Visual directions to explore
   - Colors to try later (start B&W)
   - What to avoid (competitor similarities)
   - 2-3 concept directions with different metaphors/symbols
6. **Pick a Google Font** for the brand personality:
   - `Space Grotesk` — modern tech, geometric
   - `Inter` — clean, versatile, startup
   - `Playfair Display` — elegant, editorial, luxury
   - `DM Sans` — friendly, approachable, SaaS
   - `Outfit` — contemporary, balanced
   - `Sora` — futuristic, geometric
   - `Libre Baskerville` — traditional, trustworthy
   - `Rubik` — rounded, playful, consumer
   - Or any other Google Font that fits

### Phase 2: Symbol Generation

**Goal:** Create the core symbol/icon.

1. **Read `references/prompt-patterns.md`** for prompt formulas and universal anchors.
2. **Generate 4-6 symbol variations** using the `replicate` skill:
   - Use the logomark prompt pattern from the reference
   - Vary the CONCEPT across generations (different metaphors), not just style
   - Start monochrome: `Using only black (#000000). Monochrome design.`
   - Output to `logos/<brand-name>/round-1/`
3. **VIEW EVERY RESULT with Read.** For each generated image:
   - `Read("logos/<brand>/round-1/<filename>.webp")`
   - Describe what you see: shape, composition, cleanliness, any artifacts
   - Run the self-critique checklist (see below)
   - **If it fails 2+ criteria: regenerate with adjusted prompt.** Note what went wrong and fix it in the next prompt.
   - **If it passes: keep it and note what works well.**
4. **Remove backgrounds** on the best 2-3 symbols:
   - Use the `replicate` skill with a background-removal model
   - **Read the transparent PNG to check for halos/artifacts**
   - If bad: re-run with `scripts/remove_bg.py` (local fallback)
5. **Build contact sheet, open it, and give the user the path:**
   ```bash
   python3 skills/logo-creator/scripts/create_logo_sheet.py \
     logos/<brand-name>/round-1/ \
     logos/<brand-name>/round-1/sheet.html \
     --title "<Brand> Symbols — Round 1" && \
   open logos/<brand-name>/round-1/sheet.html
   ```
   Tell the user: "The interactive contact sheet is at `logos/<brand>/round-1/sheet.html` — you can toggle light/dark backgrounds and zoom into each symbol."
6. **Ask user:** Which direction(s) do you like? What to change?

### Phase 3: Composition

**Goal:** Combine approved symbol + real typography into complete logo layouts.

```bash
python3 skills/logo-creator/scripts/compose_logo.py \
  --brand "BrandName" \
  --symbol "logos/<brand>/round-1/symbol-transparent.png" \
  --output-dir "logos/<brand>/composed/" \
  --font "Space Grotesk" \
  --weight 700 \
  --color "#1a1a2e" \
  --tagline "Optional tagline" \
  --layouts all
```

Produces 6 layouts: logomark, wordmark, wordmark-tagline, combo-horizontal, combo-vertical, combo-icon-right.

**After composing — READ every output:**
- `Read("logos/<brand>/composed/<brand>-combo-horizontal.png")` — check symbol-text balance
- `Read("logos/<brand>/composed/<brand>-combo-vertical.png")` — check nothing clips
- `Read("logos/<brand>/composed/<brand>-wordmark.png")` — check font rendered correctly

If anything looks wrong (font didn't load, proportions off, text clipped), re-run with adjusted parameters.

**Build contact sheet, open it, and tell the user:**
```bash
python3 skills/logo-creator/scripts/create_logo_sheet.py \
  logos/<brand>/composed/ \
  logos/<brand>/composed/sheet.html \
  --title "<Brand> — Compositions" --cols 2 && \
open logos/<brand>/composed/sheet.html
```
Tell the user: "All compositions are at `logos/<brand>/composed/sheet.html` — the contact sheet lets you compare all layouts side by side with light/dark background toggles."

### Phase 4: Iterate & Refine

Possible refinements:
- **Different font** — try another Google Font family
- **Different weight** — 400 for elegance, 800+ for boldness
- **Color** — `--color "#2563eb"` for brand color
- **Letter spacing** — `-0.01em` tighter, `0.05em` more open
- **Uppercase** — `--text-transform uppercase`
- **Different symbol** — generate new ones if concept is wrong
- **Dark mode** — `--bg "#1a1a2e" --color "#ffffff"`

Each iteration = adjust parameters → re-run compose → **Read to verify** → rebuild contact sheet.

**Max 3 rounds.** If stuck, rethink the concept.

### Phase 5: Finalize & Deliver

1. **Transparent versions** of approved compositions:
    - Use the `replicate` skill for final transparent exports
   - **Read to verify** clean edges
   - Fallback to `scripts/remove_bg.py` if needed
2. **Dark-mode versions** if useful
3. **Build and open final contact sheet:**
   ```bash
   python3 skills/logo-creator/scripts/create_logo_sheet.py \
     logos/<brand>/final/ logos/<brand>/final/sheet.html \
     --title "<Brand> — Final Logo Package" --cols 2 && \
   open logos/<brand>/final/sheet.html
   ```
4. **Present to user with explicit paths:**
   - List all files in `logos/<brand>/final/` with what each one is (logomark, wordmark, combo, etc.)
   - Tell user: "The interactive contact sheet is at `logos/<brand>/final/sheet.html`"
   - Note the Google Font used so they can use it in their own materials
   - Suggest next steps (test at small sizes, create social media profiles, etc.)

---

## compose_logo.py Reference

| Flag | Default | Description |
|---|---|---|
| `--brand` | required | Brand name (rendered as text) |
| `--symbol` | optional | Path to symbol image |
| `--output-dir` | `logos/composed/` | Where to save outputs |
| `--font` | `Inter` | Google Font family name |
| `--weight` | `700` | Font weight (100-900) |
| `--color` | `#000000` | Text color |
| `--bg` | `#ffffff` | Background color |
| `--tagline` | empty | Optional tagline text |
| `--letter-spacing` | `0.02em` | CSS letter-spacing |
| `--text-transform` | `none` | `none`, `uppercase`, `lowercase` |
| `--layouts` | `all` | Comma-separated or `all` |

Also accepts a JSON config file as first positional argument.

Features: auto-crops symbol whitespace, loads Google Fonts live via Playwright, single browser instance, transparent PNG support.

---

## Self-Critique Checklist

Run against what you SEE (via Read) after EVERY generated image. Discard and regenerate if 2+ fail:

- [ ] **Centered?** Design is centered in frame, not drifting
- [ ] **Clean background?** Solid white, no noise or gray patches
- [ ] **Simple enough?** Could be recognized at 32x32 pixels
- [ ] **No unwanted text?** No random letters, words, or watermarks
- [ ] **Scalable?** No fine detail that vanishes small
- [ ] **Professional?** Looks like a real product's logo, not clip art
- [ ] **Unique?** Doesn't obviously copy a well-known logo
- [ ] **On-brand?** Communicates the intended personality
- [ ] **Clean edges?** (after remove_bg) No halos, no eaten lines, no gray fringe

---

## Rules

1. **ALWAYS Read images after generating/composing.** No blind trust. Look at your work.
2. **ALWAYS give the user file paths and open contact sheets.** After building a contact sheet, run `open <path>` AND tell the user the path. Never just say "here are your logos" without showing where they are.
3. **Never present more than 6 options at once.** Curate ruthlessly.
4. **Never generate without universal anchors.** See `references/prompt-patterns.md`.
5. **Always start monochrome.** Color comes in refinement rounds.
6. **Always use compose_logo.py for text.** Never ask AI to render text.
7. **Always build contact sheets.** Visual comparison is essential. Always `open` the HTML after building it.
8. **Descriptive filenames.** `logomark-arrow-minimal.png` not `image_abc123.png`.
9. **Max 3 refinement rounds.** If stuck, rethink the concept.
10. **Verify remove_bg quality.** Read the transparent PNG. If it has artifacts, use the local fallback script.
