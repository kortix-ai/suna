---
name: kortix-image
description: Generates clean, on-brand Kortix/Suna images — hero, product, social, blog, illustration, and UI assets. Use when the user asks to create, art-direct, or revise images for Kortix, Suna, agents, sandboxes, coding workflows, launch assets, thumbnails, or covers.
---

# Kortix Image Generation

Turn a visual request into one clean, brand-safe image.

**Output PNG by default. Only output SVG when the user explicitly asks for SVG.**

## Before starting

Read the product marketing context first: if `/product-marketing.md` exists, read it before asking anything and reuse what it already covers — only ask for what's task-specific or genuinely missing.

Then settle the context below. Default sensibly from the brand and the request; ask only what actually changes the art direction — don't interrogate.

- **Image goal** — type (blog hero, social graphic, product mockup, banner, brand asset, OG image), platform/placement (website, social, directory, app store, email), and dimensions.
- **Production approach** — existing brand assets to honor, photorealistic vs. illustrative, one-off vs. reusable template.
- **Technical** — available image tools/keys (Gemini, Replicate/Flux, Ideogram), any budget limit, and whether it needs web-performance optimization.

## Brand source

Read [`../brand-guidelines/SKILL.md`](../brand-guidelines/SKILL.md) for colors, typography, logo rules, and the one-accent discipline. It is the source of truth — if a request conflicts with it, say so and offer the closest on-brand option.

## Messaging source

Read [`../internal-comms/SKILL.md`](../internal-comms/SKILL.md) for positioning, canonical terminology, and approved wording before writing any in-image text, caption, or headline. brand-guidelines governs how it looks; internal-comms governs what it says — if a copy request conflicts with it, say so and offer the closest on-message option.

## Logo

Never let the image model invent, redraw, or restyle the mark, and never generate it. Composite the official logo asset (the file the user provides, or an existing brand asset) in after generation. If no logo file is available, ask for one — don't substitute a different shape.

- Small logo in the top-left safe area on every image.
- Hero / blog / social / launch / cover images: also place one large central logo as the brand anchor.
- Recolor to the surface: near-black `#0A0A0A` on light, white `#FAFAFA` on dark. Never place the white mark on a light background.

## Defaults

- **Palette:** neutral Kortix surfaces (`#0A0A0A` / `#FAFAFA`), exactly one accent. Never a rainbow.
- **Style:** premium utilitarian minimalism. Product-grounded — agents, repos, sandboxes, sessions, terminals, pull requests, traces. Not sci-fi.
- **Composition:** strong whitespace, one focal point, one icon family, 1px borders, soft shadows.
- **Text:** avoid rendering text in-image (models corrupt it). Reserve the space and add real Roobert copy after. If text is essential, use 1–5 user-supplied words only.

## Specs

Generate at the surface's native size and keep critical content crop-safe:

- OG / blog hero: **1200×630** (1.91:1)
- X/Twitter post: **1200×675** (16:9) · header **1500×500**
- LinkedIn: **1200×627** · personal cover **1584×396**
- Square (IG / launch card): **1080×1080** · story / reel **1080×1920** (9:16)

Always pin the aspect ratio in the prompt — a forgotten ratio is the #1 cause of unusable output.

## Tools

- **General generation:** Gemini or Flux — clean render or photoreal.
- **Brand consistency across a set:** Flux multi-reference.
- **Text that must live in-image:** Ideogram renders text best — but prefer the default (composite real Roobert after).
- **Product UI:** never generate it — models hallucinate interfaces. Screenshot the real Kortix/Suna UI at 2× and frame it.

## Workflow

1. Confirm the surface, aspect ratio, and any required text/facts from Before starting. Default sensibly; ask one question only if the surface or required text genuinely changes the art direction.
2. Write **one short prompt**: subject + Kortix product truth + brand direction (neutral, one accent) + composition + aspect ratio. Keep it tight — over-specifying produces worse images.
3. Generate as PNG. Composite the official logo and any exact text after.
4. If it's for web, also export an optimized **WebP** (≈80% quality, set explicit width/height to avoid layout shift, add descriptive alt text).
5. Reject (don't ship) anything with a drawn/garbled logo, more than one accent, mangled text, generated product UI, or generic AI slop.

## Avoid

Robot mascots, glowing brains, neon grids, holograms, glassmorphism, rainbow gradients, invented logos, generated/hallucinated product UI, stock office scenes, busy dashboards, meaningless charts, and vague words like "futuristic", "next-gen", or "seamless".
