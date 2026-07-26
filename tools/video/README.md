# Kortix marketing video

[Remotion](https://remotion.dev) compositions for Kortix marketing films. Kept
out of the app build — this is a standalone npm project with its own lockfile.

## Setup

Assets are not committed here; they already live in `apps/web`. Copy them in:

```sh
npm install
mkdir -p public/fonts public/shots
cp ../../apps/web/public/fonts/roobert/RoobertUprightsVF.woff2 public/fonts/
cp ../../apps/web/public/fonts/roobert/RoobertMonoUprightsVF.woff2 public/fonts/
cp ../../apps/web/public/images/landing-showcase/platform-v2/*.png public/shots/
cp ../../apps/web/public/wallpapers/nebula-dark.jpg public/
```

## Use

```sh
npm run studio                                   # live editor
npx remotion render src/index.ts Sizzle out/kortix-sizzle.mp4
```

`Sizzle` is a 43s film: title card → typographic statement → prompt close-up →
progress → product beats → end card. Scenes live in `src/scenes.tsx` and are
composed in `src/Sizzle.tsx`; brand tokens are in `src/theme.ts`.
