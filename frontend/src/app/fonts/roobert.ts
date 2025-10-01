// app/fonts/roobert.ts
import localFont from "next/font/local";

export const roobert = localFont({
  src: [
    { path: "../../../public/fonts/roobert/RoobertUprightsVF.woff2", style: "normal", weight: "100 900" },
    { path: "../../../public/fonts/roobert/RoobertItalicsVF.woff2", style: "italic", weight: "100 900" },
  ],
  variable: "--font-roobert",
  display: "swap",
  declarations: [
    {
      prop: "font-feature-settings",
      value: "'salt' on, 'ss10' on, 'ss09' on, 'ss01' on, 'ss02' on, 'ss03' on, 'ss04' on, 'ss14' on",
    },
  ],
});
