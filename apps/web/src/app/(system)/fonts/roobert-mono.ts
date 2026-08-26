// app/fonts/roobert-mono.ts
import localFont from "next/font/local";

export const roobertMono = localFont({
  src: [
    { path: "../../../../public/fonts/roobert/RoobertMonoUprightsVF.woff2", style: "normal", weight: "100 900" },
    { path: "../../../../public/fonts/roobert/RoobertMonoItalicsVF.woff2", style: "italic", weight: "100 900" },
  ],
  variable: "--font-roobert-mono",
  display: "swap",
  // Not preloaded, unlike the sans. `next/font` emits a <link rel=preload> for
  // every file in `src`, so both mono variable fonts (210KB) were downloaded on
  // every cold page load. Measured on the session route with a production
  // build: `document.fonts` reports `roobertMono normal` and `roobertMono
  // italic` as `unloaded` — the browser fetched 210KB it never rendered with.
  // Mono only appears inside code blocks, terminal output and tool results, so
  // it is never above-the-fold chrome; with `display: "swap"` the face is
  // fetched the moment the first mono glyph lays out and swaps in.
  //
  // The sans (roobert.ts) keeps its preload: `roobert normal` IS the page.
  preload: false,
  declarations: [
    {
      prop: "font-feature-settings",
      value: "'ss10' on, 'ss09' on, 'ss03' on, 'ss04' on, 'ss14' on",
    },
  ],
});
