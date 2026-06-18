---
name: brand-guidelines
description: Applies official Kortix colors, type, and layout from kortix.com to decks, docs, slides, and other artifacts. Use when matching brand visuals, formatting deliverables, or checking work against company design standards.
---

# Kortix Brand Styling

## Overview

This skill is the entry point for Kortix visual identity on [kortix.com](https://kortix.com)—colors, typography, accents, shadows, spacing, and motion for any branded output.

**Keywords**: Kortix, kortix.com, brand identity, visual identity, brand colors, typography, Roobert, styling, layout, corporate design, post-processing

## Brand Guidelines

### Colors

All values are hex, converted from the source OKLCH tokens. Build on a neutral base and use a **single** accent per surface — never a rainbow.

**Core neutrals (Light / Dark):**

| Token            | Light     | Dark      | Use                                  |
| ---------------- | --------- | --------- | ------------------------------------ |
| Background       | `#FFFFFF` | `#0A0A0A` | Page background                      |
| Foreground       | `#0A0A0A` | `#FAFAFA` | Primary text                         |
| Card / surface   | `#F3F3F3` | `#171717` | Elevated surfaces                    |
| Muted surface    | `#F5F5F5` | `#262626` | Secondary surfaces, fills           |
| Muted text       | `#737373` | `#A1A1A1` | Secondary / supporting text          |
| Border           | `#E5E5E5` | `#27272A` | Hairlines, dividers, outlines        |
| Input            | `#F2F2F2` | `#262626` | Form field fills                     |
| Ring (focus)     | `#A1A1A1` | `#737373` | Focus rings                          |
| Primary          | `#171717` | `#E5E5E5` | High-emphasis fills / buttons        |

**Brand accents (pick ONE per surface):**

- Blue: `#2B91F7` — primary semantic accent
- Yellow: `#CCA300`
- Orange: `#D18B19`
- Green: `#8AD693`
- Purple: `#AB80D6`
- Red: `#F14B4C`

**Chart ramp (data visualization only):** `#FFD230` → `#FE9A00` → `#E17100` → `#BB4D00` → `#973C00`

**Destructive:** `#E7000B` (light) / `#FF6467` (dark)

### Typography

- **Sans (headings & body):** Roobert — fallback to **Inter**, then system sans; never serif or decorative display
- **Mono (code & product nouns):** Roobert Mono — `kortix.toml`, sessions, CLI, paths, identifiers; fallback to system mono
- **Weights:** Regular, Medium, Semibold only (2–3 per surface); avoid Light at small sizes and Black except hero covers
- **Scale:** Hero 56–72px / 40–54pt · Display 36–48px / 28–36pt · Heading 24–28px / 18–22pt · Body 16px / 11–12pt · Caption 12–14px / 9–10pt
- **Note:** Roobert should be pre-installed for best results; it falls back cleanly to Inter when unavailable

**Tracking & leading:**

- **Tracking:** `0em` (normal) is the default for body and most UI. Apply tight tracking (`-0.01` to `-0.02em`) only on hero / large display type. Never loosen body tracking.
- **Leading:** Headings 1.15–1.25× · Body 1.5–1.6× · Caption 1.4×. Keep body measure 45–75 characters.

### Logo

Do not invent marks, alternate wordmarks, or decorative lockups.

**Rules:**

- **16:9 layouts (slides/covers):** use the Kortix **symbol only**, placed top-left. Use the full logo (symbol + wordmark) only when the full logo is explicitly requested.
- **Light surfaces:** recolor fills to near-black `#0A0A0A`. Prefer the symbol alone unless the layout needs the full wordmark.
- **Dark surfaces:** use white fills `#FAFAFA`. Never place the white logomark on light backgrounds.
- **One mark per surface** — same placement discipline as accents (no competing logos).
- **Recoloring:** edit fill/stroke/`currentColor` to `#0A0A0A` or `#FAFAFA`; never substitute a different shape.

### Spacing & Radius

- **Spacing unit:** `0.23rem` base (`--spacing`). Build gaps and padding as multiples of this unit for consistent rhythm.
- **Radius:** `0.625rem` (10px) base (`--radius`). Use `md` for cards and controls, `lg` (≈1rem) for large panels and covers.
- **Border width:** `1px` everywhere; rely on the `border` token, not heavier strokes.

### Shadows

Shadows are **subtle only** — low opacity, small offsets, no glow or neon. Shadow color: `#1A1F2E` (light) / `#000000` (dark).

| Level     | Offset / blur                                | Opacity |
| --------- | -------------------------------------------- | ------- |
| `2xs`/`xs`| `0px 1px 2px`                                | `0.02`  |
| `sm` / —  | `0px 1px 2px` + `0px 1px 2px -1px`           | `0.04`  |
| `md`      | `0px 1px 2px` + `0px 2px 4px -1px`           | `0.04`  |
| `lg`      | `0px 1px 2px` + `0px 4px 6px -1px`           | `0.04`  |
| `xl`      | `0px 1px 2px` + `0px 8px 10px -1px`          | `0.04`  |
| `2xl`     | `0px 1px 2px`                                | `0.10`  |

### Motion

Animate with purpose — fade, slide, or product-reveal only.

- **Durations:** fast `100ms` · normal `150ms` · moderate `200ms` · slow `300ms` · slower `500ms`
- **Easing:** default `cubic-bezier(0.2, 0, 0, 1)` · in `cubic-bezier(0.4, 0, 1, 1)` · out `cubic-bezier(0, 0, 0.2, 1)` · in-out `cubic-bezier(0.4, 0, 0.2, 1)`
- **Default pairing:** 150–200ms with `ease-default` for most UI transitions.

## Features

### Smart Font Application

- Applies Roobert to headings and body (3–4 text styles max per surface: title, heading, body, caption)
- Applies Roobert Mono to product nouns, paths, commands, and config snippets
- Automatically falls back to Inter / system sans if Roobert unavailable
- Preserves readability across all systems

### Text Styling

- Hero / cover: Roobert Semibold, tight tracking, one per cover
- Headings (24px+): Roobert Medium or Semibold, leading 1.15–1.25×
- Body: Roobert Regular, 16px floor, leading 1.5–1.6×, measure 45–75 characters
- Smart color selection: neutral surfaces with one meaningful accent
- Flush-left / ragged-right; no justified body; preserve hierarchy

### Shape and Accent Colors

- Neutral (black/white/gray) surfaces with **one** accent per artifact
- Non-text shapes use a single chosen accent from the palette above
- Semantic colors (error, chart ramp) only when content requires them
- Subtle shadows only (see scale above) — no glow or neon

## Technical Details

### Font Management

- Uses system-installed Roobert and Roobert Mono when available
- Provides automatic fallback to Inter / system sans, and any mono for code
- No font installation required for drafts — works with fallbacks
- For best results, pre-install Roobert and Roobert Mono in your environment

### Color Application

- Uses hex/RGB values for precise brand matching
- Light mode: background `#FFFFFF`, foreground `#0A0A0A`, border `#E5E5E5`
- Dark mode: background `#0A0A0A`, foreground `#FAFAFA`, border `#27272A`
- See Spacing & Radius, Shadows, and Motion above for the rest of the token system

### Voice (copy on branded artifacts)

- Direct, product-grounded; concrete nouns: sessions, repos, sandboxes, skills, change requests
- Banned: "unlock productivity", "AI transformation", "seamless", "revolutionary", and other generic SaaS claims with no mechanism
- One audience per sentence; lead with real product proof, not abstract AI art

> For positioning, terminology, audience pitches, and the full don't-say / prefer wording list, use [`../internal-comms/SKILL.md`](../internal-comms/SKILL.md) — the verbal source of truth that complements these visual guidelines.
