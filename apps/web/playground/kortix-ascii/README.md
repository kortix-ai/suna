# Kortix ASCII-art playground

> ⚠️ **Unfinished experiment / play-around — not wired to anything.** Parked here
> for reference. It is not imported by the web app or the CLI.

A tiny, dependency-free tool that turns the official Kortix brand SVGs into
terminal ASCII art — the same idea as the [game-of-life landing
canvas](../../src/app/game-of-life) (load the real brandmark, sample pixel
coverage, stamp it into a grid), except it emits characters instead of canvas
cells. It flattens the SVG paths' cubic béziers and fills them with an even-odd
scanline, then maps coverage to glyphs (solid blocks, half-blocks, shaded
ramps, a figlet-style ANSI-shadow bevel, etc.).

The original goal was to replace the hand-typed `KORTIX` block letters in the
CLI banner (`apps/cli/src/banner.ts`) with the real mark. We didn't land on a
version we liked, so the CLI banner was left as-is and this was set aside.

## Files

- `generate.mjs` — the generator (the only thing that should write the glyphs).
- `kortix-wordmark.txt` — the canonical `KORTIX` figlet wordmark (source input).
- `ascii-logo.md` — **the catalog**: every variation, rendered, with notes.
- `ascii-logo.generated.ts` — the same art as exact, importable string constants.

Source of truth: `apps/web/public/brandkit`.

## Run

```bash
# from apps/web/
node playground/kortix-ascii/generate.mjs            # print the catalog to stdout
node playground/kortix-ascii/generate.mjs --write     # (re)generate ascii-logo.md + .ts
```

## ⚠️ Using the art: copy it, never write it

These are box-drawing / half-block glyphs (`▀ ▄ █ ╗ ╔ ╝ ░ ▒ ▓`). An LLM/agent
**cannot** reproduce them by typing — next-token prediction silently corrupts
the alignment. Either `import` a constant from `ascii-logo.generated.ts`, or copy
the exact lines out of `ascii-logo.md` byte-for-byte. To change the art, edit/run
`generate.mjs` — never hand-edit the generated outputs.
