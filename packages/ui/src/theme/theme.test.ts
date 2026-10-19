import { expect, test } from 'bun:test';

import { themeToCss, themeToCssVars } from './theme';

test('themeToCssVars maps light and dark colors and repeats shared values in both modes', () => {
  const vars = themeToCssVars({
    light: { primary: '#4f46e5', border: '#e0e7ff' },
    dark: { primary: '#818cf8' },
    radius: '0.25rem',
    fonts: { sans: 'Inter, sans-serif' },
    shadows: { md: '0 0 #0000' },
    text: { sm: '0.9rem' },
    durations: { normal: '120ms' },
    easing: { inOut: 'linear' },
    vars: { '--liquid-glass-blur': '8px' },
  });
  const shared = {
    '--radius': '0.25rem',
    '--font-family-sans': 'Inter, sans-serif',
    '--text-sm': '0.9rem',
    '--shadow-md': '0 0 #0000',
    '--duration-normal': '120ms',
    '--ease-in-out': 'linear',
    '--liquid-glass-blur': '8px',
  };
  expect(vars.light).toEqual({ ...shared, '--primary': '#4f46e5', '--border': '#e0e7ff' });
  expect(vars.dark).toEqual({ ...shared, '--primary': '#818cf8' });
});

test('custom --vars pass through per mode; an overridden source re-declares its var() aliases unless the theme sets them', () => {
  const { light, dark } = themeToCssVars({ light: { ring: 'red', focusRing: 'blue' }, dark: { ring: 'green' } });
  expect(light['--focus-ring']).toBe('blue');
  expect(light['--sidebar-ring']).toBe('var(--ring)');
  expect(light['--kortix-base']).toBe('var(--ring)');
  expect(dark['--focus-ring']).toBe('var(--ring)');
  expect(themeToCssVars({ radius: '0' }).light).toEqual({ '--radius': '0' });
  expect(themeToCssVars({ dark: { '--brand': 'indigo', blue: 'var(--brand)' } }).dark).toEqual({
    '--brand': 'indigo',
    '--kortix-blue': 'var(--brand)',
  });
});

test('themeToCss scopes light outside .dark and dark on or inside .dark', () => {
  expect(themeToCss({ light: { primary: 'red' }, dark: { primary: 'blue' } }, '[data-x]')).toBe(
    '[data-x]:not(.dark, .dark *) {\n  --primary: red;\n}\n[data-x].dark, .dark [data-x] {\n  --primary: blue;\n}',
  );
  expect(themeToCss({ light: { primary: 'red' } })).toBe(':root:not(.dark, .dark *) {\n  --primary: red;\n}');
  expect(themeToCss({})).toBe('');
});

test('unknown keys are rejected by the types and at runtime', () => {
  // @ts-expect-error `primry` is not a theme color.
  expect(() => themeToCss({ light: { primry: 'red' } })).toThrow('unknown color "primry"');
  // @ts-expect-error `radii` is not a theme field.
  themeToCssVars({ radii: '0' });
  // @ts-expect-error a custom variable must start with --.
  themeToCssVars({ vars: { radius: '0' } });
});
