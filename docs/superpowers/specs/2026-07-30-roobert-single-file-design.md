# Roobert: single-file variable font for apps/web

Date: 2026-07-30
Status: design approved, implementation plan not yet written
Scope: `apps/web` only

## Problem

Three complaints, one root cause each.

1. **Four font files where one should do.** `apps/web` ships four Roobert `.woff2`
   files totalling 524 KB and requests up to four of them.
2. **The weight ladder is a lie.** The CSS declares `weight: "100 900"`. The font's
   `wght` axis is `300–900`. `font-thin` and `font-extralight` silently render as
   Light 300.
3. **The mono font looks wrong in code.** Two independent causes, both verified
   below: ligatures collapse monospace cells, and display-only stylistic sets are
   applied to code text.

## Verified findings

All measurements are from Chromium via Playwright, or from HarfBuzz shaping over
the real font binaries. Commands and outputs are in the session handoff
(`/tmp/roobert-font-handoff-2026-07-30.md`).

### F1 — The single file already exists in this repo

`apps/mobile/assets/font/Roobert/RoobertCollectionVF.woff2`, 293 KB, three axes:

| Axis   | Range      | Meaning                        |
| ------ | ---------- | ------------------------------ |
| `wght` | 300 → 900  | Light … Heavy                  |
| `ital` | 0 → 11     | upright → true italic          |
| `MONO` | 0 → 100    | sans → SemiMono (60) → mono    |

36 named instances. `apps/web` has never used it.

It is a **lossless** replacement for all four current files. At `ital=11` the
glyph `n` has bounds `(28, 0, 527, 512)` — byte-identical to the standalone
`RoobertItalicsVF.woff2` shipping today.

The four current web files each expose only `wght` in `fvar`, but all four declare
`wght`, `ital`, **`MONO`** in `STAT`. That mismatch is what identified them as
single-axis cuts of a larger master.

### F2 — Weights 100, 200 and 950 do not exist

The `wght` axis floors at 300 and caps at 900. No Thin, ExtraLight, or Black file
exists among the ~150 Roobert files in `apps/mobile`. CSS cannot create weights
outside a design space; the browser clamps. Extrapolating past the axis distorts
outlines and is not an option.

### F3 — Ligatures break monospace alignment (live in production)

Five character sequences collapse into fewer cells at `MONO=100`:

| Sequence   | Cells   | Fixed by `calt off` | Feature group |
| ---------- | ------- | ------------------- | ------------- |
| `->` `<-`  | 2 → 1   | yes                 | `calt`        |
| `tt` `ff`  | 2 → 1   | **no**              | `liga`        |
| `ffi`      | 3 → 2   | **no**              | `liga`        |

`tt` and `ff` are the damaging pair: `getAttribute`, `setTimeout`, `pattern`,
`http`, `diff`, `offset`, `buffer`, `off`.

Measured widths of five 17-character lines, current config vs proposed:

```
current    170.8  141.1  140.6  161.3  169.9   px   <- ragged
proposed   170.8  171.4  171.4  171.4  171.3   px   <- flush
```

`getAttribute->off` renders 30px — three cells — short.

One property fixes all five: **`font-variant-ligatures: none`**. Disabling `calt`
alone is insufficient; disabling `liga`/`dlig` alone does not fix the arrows.

### F4 — `ital` is 0–11, not 0–1

CSS `font-style: italic` maps to `ital=1`, which yields roughly 9% of the intended
slant (glyph `n` width 440 vs 499 at `ital=11`). Italics must set `ital` to 11
explicitly or they render nearly upright.

### F5 — Current feature settings leak display alternates into code

`roobert.ts` and `roobert-mono.ts` both apply
`'ss10' on, 'ss09' on, 'ss03' on, 'ss04' on, 'ss14' on`. Shaped effects:

- `ss03` → alternate `y`
- `ss04` → alternate `E F L`
- `ss09` → alternate `?`
- `ss14` → circular dots on `i j : ;`
- **`ss10` does nothing.** It also targets `?`; `ss09` already won. Dead config.

In code text this swaps `E`, `F`, `L`, `y`, `:`, `;`, `?` — `:` and `;` are among
the most frequent characters in TypeScript.

The sans sets are individually subtle. The loud sets (`ss01` single-storey `a`,
`ss05` rounded `MWmw`, `ss08`) are already off. The sans is not the problem.

### F6 — `@font-face` variation descriptor works, one download

Four `@font-face` rules sharing one `src` URL, each pinning axes via the
`font-variation-settings` descriptor:

```
sans   (MONO 0)          496.4px
italic (MONO 0, ital 11) 497.2px
mono   (MONO 100)        756.0px
semi   (MONO 60)         653.2px
woff2 network requests:  1
```

Values match direct `font-variation-settings` measurement exactly. Verified in
Chromium only.

### F7 — `MONO=60` is not monospaced

`const x = 1;` measures 6531 units vs `WWWWWWWWWWWW` at 9288. SemiMono is correct
for identifiers and labels, and wrong for code, diffs, and any column-aligned
table.

### F8 — Licence forbids modification

Font `name[13]`: *"you should not modify, reassemble, rename, store on publicly
accessible servers, redistribute, or sell them."* Vendor `DP`, Displaay Type
Foundry s.r.o.

This rules out building a custom merged or subsetted VF with fontTools. Adopting
the foundry's own Collection file modifies nothing.

## Design

### D1 — Ship one file

Copy `RoobertCollectionVF.woff2` to `apps/web/public/fonts/roobert/`. Delete
`RoobertUprightsVF.woff2`, `RoobertItalicsVF.woff2`,
`RoobertMonoUprightsVF.woff2`, `RoobertMonoItalicsVF.woff2`.

**524 KB across 4 files → 293 KB in 1. 44% smaller, one request.**

### D2 — Four families, one `src`

Hand-author the `@font-face` rules in `globals.css`. Do **not** use four
`localFont()` calls: `next/font/local` fingerprints per call and would emit the
293 KB file four times (~1.2 MB), worse than today.

| Family             | Descriptor              | Token             |
| ------------------ | ----------------------- | ----------------- |
| `Roobert` normal   | `"MONO" 0, "ital" 0`    | `--font-sans`     |
| `Roobert` italic   | `"MONO" 0, "ital" 11`   | `--font-sans`     |
| `Roobert Mono`     | `"MONO" 100`            | `--font-mono`     |
| `Roobert SemiMono` | `"MONO" 60`             | `--font-semimono` |

Because `next/font/local` no longer manages the face, add an explicit preload in
`layout.tsx`:

```html
<link rel="preload" href="/fonts/roobert/RoobertCollectionVF.woff2"
      as="font" type="font/woff2" crossorigin />
```

`layout.tsx:190` currently carries a comment stating preloading is handled by
`next/font/local`. That comment becomes false and must be updated.

### D3 — Ten-step weight ladder

Remap Tailwind v4 `--font-weight-*` theme tokens onto the real axis. All ten
names work and render distinctly. `400/500/600/700/800` are unchanged, so no
existing UI shifts.

| CSS name          | `wght` | Note              |
| ----------------- | ------ | ----------------- |
| `100` thin        | 300    | axis floor        |
| `200` extralight  | 335    |                   |
| `300` light       | 368    | shifts from 300   |
| `400` normal      | 400    | unchanged         |
| `500` medium      | 500    | unchanged         |
| `600` semibold    | 600    | unchanged         |
| `700` bold        | 700    | unchanged         |
| `800` extrabold   | 800    | unchanged         |
| `900` black       | 870    | shifts from 900   |
| `950`             | 900    | axis ceiling      |

Accepted tradeoff: `100/200/300` and `900/950` are distinct but subtle. That is
the ceiling of splitting a 600-unit axis ten ways.

### D4 — Mono feature settings

```css
font-variant-ligatures: none;    /* F3 — restores cell alignment */
font-feature-settings: "zero";   /* slashed zero, disambiguates 0 from O */
```

Remove `ss03`, `ss04`, `ss09`, `ss10`, `ss14` from the mono family entirely.

### D5 — Sans feature settings

Keep `ss03`, `ss04`, `ss09`, `ss14`. Delete `ss10` (F5, dead config).

### D6 — New `font-semimono` token

Expose `MONO=60` for session IDs, hashes, timestamps, and uppercase label chrome.
Explicitly **not** for code or column-aligned tables (F7).

## Out of scope

- **`apps/mobile`.** It carries ~150 Roobert files and already has
  `RoobertCollectionVF`. Same consolidation applies and is a larger win, but it
  adds Expo/NativeWind font-loading risk and a separate verification surface.
  Track as a follow-up.
- **Migrating the 680 `font-mono` call sites.** They keep working unchanged.
  Adopting `font-semimono` at specific sites is a later, taste-driven pass.
- Any modification, subsetting, or re-generation of the font binary (F8).

## Risks

| # | Risk | Mitigation |
| - | ---- | ---------- |
| R1 | Licence tier may not cover self-hosted webfonts | Confirm with Displaay. Pre-existing exposure — this design modifies nothing and does not increase it. |
| R2 | Bare `<pre>`/`<code>` do not inherit the font | UA stylesheet sets `font-family: monospace` on `pre`, `code`, `kbd`, `samp`, `textarea`, and that beats inheritance. Audit for code blocks lacking an explicit `font-mono`. This bit the specimen build itself. |
| R3 | Descriptor support verified in Chromium only | Verify in Firefox and Safari before merge. |
| R4 | Losing `next/font/local` means losing automatic preload | Explicit `<link rel="preload">` per D2; assert in the network panel that the file is requested once, early, and with `crossorigin`. |
| R5 | `--font-weight-*` remap could shift unaudited surfaces | Only `300` and `900` change. Grep `font-light` and `font-black` usage and screenshot-diff those surfaces. |

## Verification plan

Per `CLAUDE.md`, local **and** deployed checks are both required.

1. **Network** — exactly one `woff2` request; 293 KB; preloaded.
2. **Axis assertion** — in-page measurement that `MONO` 0/60/100 and `ital` 0/11
   produce the widths in F6.
3. **Alignment regression** — assert five 17-character lines including `->`, `tt`,
   `ff` all measure equal width in `font-mono`. This is the F3 regression test and
   should be automated.
4. **Weight ladder** — assert ten distinct rendered widths for the ten tokens.
5. **Visual** — screenshot `/design-system` before and after; diff.
6. **Cross-browser** — repeat 1–4 in Firefox and Safari.
7. **Deployed** — re-run against `https://dev.kortix.com` after the Deploy Dev
   workflow completes, confirming the deployed artifact contains the merged SHA.

## Files this touches

- `apps/web/public/fonts/roobert/` — add Collection VF, delete 4 files
- `apps/web/src/app/(system)/fonts/roobert.ts` — **delete**; the `@font-face`
  rules in `globals.css` replace it
- `apps/web/src/app/(system)/fonts/roobert-mono.ts` — **delete**, same reason
- `apps/web/src/app/layout.tsx` — lines 25, 26, 176, 190. Drop both `localFont`
  imports and the `roobert.variable` / `roobertMono.variable` className entries;
  the font families come from `globals.css` instead of generated CSS variables.
- `apps/web/src/app/globals.css` — lines 179, 180 plus new `@font-face` block and
  `--font-weight-*` tokens
- `apps/web/src/app/(public)/(marketing)/design-system/page.tsx` — lines 1222,
  1244 describe the type system and should mention SemiMono
