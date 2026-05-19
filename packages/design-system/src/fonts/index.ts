import localFont from 'next/font/local';

export const fontSans = localFont({
  src: [
    { path: './files/RoobertUprightsVF.woff2', style: 'normal', weight: '100 900' },
    { path: './files/RoobertItalicsVF.woff2', style: 'italic', weight: '100 900' },
  ],
  variable: '--font-roobert',
  display: 'swap',
  declarations: [
    {
      prop: 'font-feature-settings',
      value: "'ss10' on, 'ss09' on, 'ss03' on, 'ss04' on, 'ss14' on",
    },
  ],
});

export const fontVariables = fontSans.variable;
