# Kortix ASCII brand art

> **Auto-generated** by `apps/web/playground/kortix-ascii/generate.mjs` from the official
> brand SVGs in `apps/web/public/brandkit`. Same technique as the game-of-life
> landing canvas: rasterize the real mark, sample coverage, emit characters.
>
> Source: Brandmark (symbol) `164×140` · Logomark
> (symbol + wordmark) `708×142`.

## ⚠️ How to use this art — COPY IT, NEVER WRITE IT

These are box-drawing / half-block glyphs (`▀ ▄ █ ╗ ╔ ╝ ░ ▒ ▓`). **If you are an
LLM/agent you CANNOT reproduce them by typing** — next-token prediction silently
corrupts the alignment (shifted `▀▄`, broken `╗╔╝`, ragged columns). Every time
you "redraw" it, it gets worse.

**The rule: never hand-write this art. Always copy it byte-for-byte, line by line.**

- **In code** → `import { LOCKUP_HALF } from './ascii-logo.generated.ts';`. Import
  the constant; never paste the glyphs inline.
- **Anywhere else** (docs, another file, a chat message) → open the source file,
  select the exact lines, paste them **unchanged**. Do not re-align, "clean up",
  fix, or retype a single character.
- **To change the art** → edit/run `generate.mjs`. Never edit the
  generated output (`ascii-logo.md`, `ascii-logo.generated.ts`) by hand.

## Curation — what NOT to use

Some renders look like ass and were **removed on purpose**, so this catalog only
contains art that's actually good:

- **No small `solid` symbols** (w<32) — the radial blades collapse into a
  blocky hash. Use **half-block** for small sizes; it has 2× the vertical detail.
- **No `solid` lockup / logomark** — the symbol/wordmark go mushy. Half-block and
  shaded only.

---

## Lockups — symbol + KORTIX

Pair the mark with the wordmark. `LOCKUP_HALF` = flat half-block, symbol same size as the word; `LOCKUP_BEVEL` = both rasterized + 3D-extruded at matched size. (The CLI banner itself uses the full logomark — see below.)

### lockup · halfblock (flat, matched size)

```
 █▄   ██   ▄█   ██╗  ██╗ ██████╗ ██████╗ ████████╗██╗██╗  ██╗
 ██▄  ██  ▄██   ██║ ██╔╝██╔═══██╗██╔══██╗╚══██╔══╝██║╚██╗██╔╝
  ▀██▄██▄██▀    █████╔╝ ██║   ██║██████╔╝   ██║   ██║ ╚███╔╝
  ▄██▀██▀██▄    ██╔═██╗ ██║   ██║██╔══██╗   ██║   ██║ ██╔██╗
 ██▀  ██  ▀██   ██║  ██╗╚██████╔╝██║  ██║   ██║   ██║██╔╝ ██╗
 █▀   ██   ▀█   ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝╚═╝  ╚═╝
```

### lockup · bevel (3D, matched size)

```
  ██╗       ██╗       ██╗
  ███╗     ████╗     ███║      ██╗    ██╗                          █╗
  ████╗    ████║    ████║      ███╗   ██║                  ███╗   ██║
  ╚████╗   ████║   ████╝╝      ███║ ███╝╝   ████╗       ██╗██████╗╚█║ ██╗    ██╗
   ╚█████████████████╝═╝       ███████╝╝ █████████╗  █████║██████║███╗███╗  ███║
    ╚═██████████████╝╝         ███████║  ██╝════███╗███╝══╝███╝══╝███║╚███████╝╝
    ██████████████████╗        ███╝═███╗ ██║    ███║███║   ███║   ███║ ███████║
   ████╝═══████╝═══████╗       ███║ ╚═██╗█████████╝╝███║   ██████╗███║███╝══███╗
  ████╝╝   ████║   ╚████╗      ██╝╝   ██║╚══████╝═╝ ╚█╝╝   ╚══███║╚█╝╝██╝╝  ╚██║
  ███╝╝    ████║    ╚███║      ╚═╝    ╚═╝   ╚═══╝    ╚╝       ╚══╝ ╚╝ ╚═╝    ╚═╝
  ██╝╝     ╚██╝╝     ╚██║
  ╚═╝       ╚═╝       ╚═╝
```

### wordmark only (KORTIX, figlet)

```
██╗  ██╗ ██████╗ ██████╗ ████████╗██╗██╗  ██╗
██║ ██╔╝██╔═══██╗██╔══██╗╚══██╔══╝██║╚██╗██╔╝
█████╔╝ ██║   ██║██████╔╝   ██║   ██║ ╚███╔╝ 
██╔═██╗ ██║   ██║██╔══██╗   ██║   ██║ ██╔██╗ 
██║  ██╗╚██████╔╝██║  ██║   ██║   ██║██╔╝ ██╗
╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝╚═╝  ╚═╝
```

---

## The symbol — ANSI-shadow bevel (`█ ╗ ║ ═ ╝ ╚`)

The symbol in the wordmark's extruded style. Only L — smaller sizes press the radial blades together.

### symbol · shadow · L (w=32)

```
  ████╗       ████╗       ████╗
  █████╗      ████║      █████║
  ╚█████╗     ████║     █████╝╝
   ╚██████╗   ████║   ██████╝╝
    ╚═████████████████████╝═╝
      ╚═████████████████╝═╝
      ████████████████████╗
    ██████╝═══████╝═══██████╗
   █████╝═╝   ████║   ╚═█████╗
  █████╝╝     ████║     ╚█████╗
  ████╝╝      ████║      ╚████║
  ╚═══╝       ╚═══╝       ╚═══╝
```

---

## The symbol — half-block (`▀ ▄ █`, 2× vertical detail)

Flat go-to symbol style. Each glyph packs two pixel rows, so the radial blades stay crisp even at small sizes.

### symbol · halfblock · M

```
 ▄▄▄     ▄▄▄      ▄▄▄
 ███     ███     ▄██▀
  ███▄   ███    ▄███
   ▀███▄ ███  ▄███▀
     ▀██████████▀
    ▄███▀███▀▀███▄
  ▄███▀  ███   ▀███▄
 ▄██▀    ███     ███
 ███     ███      ███
```

### symbol · halfblock · L

```
  ▄▄▄▄         ▄▄▄▄         ▄▄▄▄
  ████         ████        ▄████
  █████        ████        ████▀
   ████▄       ████       █████
   ▀█████▄     ████     ▄█████
     ▀█████▄▄  ████  ▄▄█████▀
       ▀██████████████████▀
        ▄████████████████▄
      ███████▀▀████▀▀██████▄
    ▄█████▀    ████    ▀█████▄
   █████▀      ████      ▀████▄
  ▄████        ████       ▀████▄
  ████▀        ████        █████
  ▀▀▀▀         ▀▀▀▀         ▀▀▀▀
```

---

## The symbol — solid blocks (`█`)

Only large sizes — solid loses the blades when small (small solid is intentionally excluded; use half-block instead).

### symbol · solid · L (w=32)

```
  ████        ████        ████
  █████       ████       █████
   █████      ████      █████
    ██████    ████    ██████
      ████████████████████
        ████████████████
      ████████████████████
    ██████    ████    ██████
   █████      ████      █████
  █████       ████       █████
  ████        ████        ████
```

### symbol · solid · XL (w=48)

```
   ██████            ██████            ██████
   ██████            ██████            ██████
   ███████           ██████           ███████
    ██████           ██████          ███████
     ███████         ██████         ███████
      ████████       ██████       ████████
       █████████     ██████    ██████████
         ██████████████████████████████
           █████████████████████████
           ██████████████████████████
         ██████████████████████████████
       █████████     ██████     █████████
      ████████       ██████       ████████
     ███████         ██████         ███████
    ██████           ██████          ███████
   ███████           ██████           ███████
   ██████            ██████            ██████
   ██████            ██████            ██████
```

---

## The symbol — shaded (`░ ▒ ▓ █`)

Soft anti-aliased look.

### symbol · shaded · M

```
 ▒▒▒     ░▒▒░     ▒▒▒
 ▒██▒    ▒██░    ▒██▒
  ▓██▒   ▒██░   ▒██▓
   ▒███▓▒▓██▒▒▓███▒
    ░▓██████████▓
   ▒███▓▒▓██▒▒▓███▒
  ▓██▒   ▒██░   ▒██▓
 ▒██░    ▒██░    ▒██▒
 ▒▒▒     ░▒▒░     ▒▒▒
```

### symbol · shaded · L

```
  ░░░░         ░░░░         ░░░░
  ████░       ░████        ▒████
  ▓███▓       ░████        ████▒
  ░████▓      ░████      ░▓███▓
   ░▓████▒░   ░████    ░▓████▓
     ▒█████▓▒░▒████░▒▒▓█████▒
       ▒▓████████████████▓▒
       ▒▓████████████████▓▒
     ▒█████▓▒░▒████░░▒▓█████▒
   ░▓████▒    ░████    ░▒████▓
  ░████▓      ░████      ░▓███▓
  ▓███▓       ░████        ████▒
  ████░       ░████        ▒████
  ░░░░         ░░░░         ░░░░
```

---

## The symbol — fine ramp (` .:-=+*#%@`)

ASCII-only (no Unicode blocks) — safest for legacy terminals.

### symbol · fine · M

```
 .:::       ::::      .:::.
 -@@@-      #@@#      -@@@:
  %@@#.     #@@#     :%@@#
  :%@@%:    #@@#    -%@@#.
   .*@@@%+:.#@@#.-+%@@@*.
     :*%@@@@@@@@@@@@%*.
     :*@@@@@@@@@@@@@%*:
   .#@@@#=: #@@# :+%@@@*.
  :%@@%:    #@@#    -%@@%.
 .%@@#.     #@@#     .%@@#
 -@@@-      #@@#      -@@@:
 .:::       ::::      .:::.
```

---

## The symbol — dots (`· • ●`)

Stippled / playful.

### symbol · dots · M

```
 •••·     ••••     ••••
 •●●•     •●●•     ●●●•
 ·●●●•    •●●•   ·•●●●
  ·●●●●•· •●●• ·•●●●•·
    ••●●●●●●●●●●●●•·
    •●●●●●●●●●●●●●••
  ·●●●●•· •●●• ·•●●●●·
 ·●●●•    •●●•    •●●●
 •●●•     •●●•     ●●●•
 •••·     ••••     ••••
```

---

## Full logomark — symbol + "Kortix" (100% rasterized SVG)  ★ (the CLI banner)

`LOGOMARK_HALF_L` is what `kortix` prints on startup — the official lockup straight from the brand file, one consistent half-block style. Only half-block / shaded are kept (solid renders the wordmark too rough at terminal size).

### logomark · halfblock · L  ★

```
    ▄▄▄    ▄▄▄    ▄▄▄      ▄▄▄     ▄▄                          ▄▄
    ▀██    ███    ██▀      ███    ███                   ██     ▀▀
     ▀██▄  ███  ▄██▀       ███  ▄███   ▄▄▄▄▄▄▄     ▄▄▄▄ ██▄▄▄▄ ▄▄ ▄▄▄    ▄▄▄
       ▀█████████▀         ███████▀   ███▀▀▀███  ▄██▀▀▀ ██▀▀▀  ██  ██▄  ▄██
      ▄███▀███▀███▄        ███▀███▄  ███     ███ ███    ██     ██   ▀████▀
     ▄██▀  ███  ▀██▄       ███   ▀██ ███     ███ ███    ██     ██  ▄██████▄
    ▄██    ███    ██▄      ███    ▀██ ▀██▄▄▄██▀  ██▀    ███▄▄▄ ██  ██▀   ██▄
    ▀▀▀    ▀▀▀    ▀▀▀      ▀▀▀     ▀▀   ▀▀▀▀▀    ▀▀      ▀▀▀▀▀ ▀▀ ▀▀▀    ▀▀▀
```

### logomark · shaded · L

```
    ▒▒▒    ▒▒▒    ▒▒▒      ░▒▒    ░▒▒                   ░░     ▒▒
    ▒██░   ▓█▓   ░██▒      ▒██    ▓█▓                  ░██░   ░▓▓░
     ▒██▒  ▓█▓  ▒██▒       ▒██  ░▓█▓   ░▒▓▓▓▒░     ░▒▒▒░██▓▒▒░░▒▒░░▒▒    ▒▒░
      ░▓██▓███▓██▓░        ▒██▓██▓▒  ░▓█▓▒▒▒▓█▓░ ▒██▒▒▒░██▓▒▒░░██░░██▒  ▒██░
      ▒▓██▓███▓██▓▒        ▒██▓▓██▒  ▓█▓     ▓█▓ ██▒   ░██░   ░██░ ░▓████▓░
     ▓██░  ▓█▓  ░██▓       ▒██  ░▓██░▓██     ██▓ ██▒   ░██░   ░██░ ░██▓▓██░
    ▒██    ▓█▓    ██▒      ▒██    ▒██ ▓██▓▒▓██▓  ██▒    ▓██▒▒░░██░░██░  ░██░
    ▒▒▒    ▒▒▒    ▒▒▒      ░▒▒    ░▒▒  ░░▒▒▒▒░   ▒▒░     ░▒▒▒░░▒▒░░▒▒    ░▒░
```

---

_Regenerate: `node apps/web/playground/kortix-ascii/generate.mjs --write`._
