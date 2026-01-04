// app/fonts/roobert-mono.ts
import localFont from "next/font/local";

export const roobertMono = localFont({
  src: [
    { path: "../../../public/fonts/roobert/RoobertMonoUprightsVF.woff2", style: "normal", weight: "100 900" },
    { path: "../../../public/fonts/roobert/RoobertMonoItalicsVF.woff2", style: "italic", weight: "100 900" },
  ],
  variable: "--font-roobert-mono",
  display: "swap",
  declarations: [
    {
      prop: "font-feature-settings",
      value: "'salt' on, 'ss10' on, 'ss09' on, 'ss01' on, 'ss02' on, 'ss03' on, 'ss04' on, 'ss14' on",
    },
  ],
});
