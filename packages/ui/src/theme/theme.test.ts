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
  expect(() => themeToCssVars({ radii: '0' })).toThrow('unknown field "radii"');
  // @ts-expect-error a custom variable must start with --.
  expect(() => themeToCssVars({ vars: { radius: '0' } })).toThrow('invalid variable name "radius"');
  // @ts-expect-error `huge` is not a text step.
  expect(() => themeToCss({ text: { huge: '9px' } })).toThrow('unknown text step "huge"');
  // @ts-expect-error `bogus` is not an easing.
  expect(() => themeToCss({ easing: { bogus: 'linear' } })).toThrow('unknown easing step "bogus"');
  // @ts-expect-error `xxl` is not a shadow step.
  expect(() => themeToCss({ shadows: { xxl: 'none' } })).toThrow('unknown shadows step "xxl"');
  // @ts-expect-error `instant` is not a duration step.
  expect(() => themeToCss({ durations: { instant: '0ms' } })).toThrow('unknown durations step "instant"');
  // @ts-expect-error `huge` is not a text step.
  expect(() => themeToCss({ lineHeights: { huge: '1' } })).toThrow('unknown lineHeights step "huge"');
});

test('a value or name that could end the declaration is rejected, so tenant data cannot add CSS rules', () => {
  for (const bad of ['red} body{display:none} x{', 'red; --x: 1', 'red /* x', 'url(x)</style>', 'a\\7d']) {
    expect(() => themeToCss({ light: { primary: bad } })).toThrow('invalid value for light.primary');
    expect(() => themeToCss({ vars: { '--x': bad } })).toThrow('invalid value for --x');
  }
  expect(() => themeToCss({ radius: 'calc(1px}' })).toThrow('invalid value for radius');
  expect(() => themeToCss({ dark: { '--a}b': 'red' } })).toThrow('invalid variable name "--a}b"');
  expect(() => themeToCss({ vars: { '--a b': 'red' } })).toThrow('invalid variable name "--a b"');
  expect(themeToCss({ fonts: { sans: '"Avenir Next", sans-serif' }, light: { primary: 'oklch(0.5 0.2 270 / 50%)' } })).toContain(
    '--primary: oklch(0.5 0.2 270 / 50%);',
  );
});

test('a scoped secondary re-derives liquid glass per mode unless the theme sets it', () => {
  const { light, dark } = themeToCssVars({ light: { secondary: 'red' }, dark: { secondary: 'blue' } });
  expect(light['--liquid-glass-bg']).toBe('color-mix(in oklch, var(--secondary) 45%, transparent)');
  expect(light['--liquid-glass-bg-hover']).toBe('color-mix(in oklch, var(--secondary) 62%, transparent)');
  expect(dark['--liquid-glass-bg']).toBe('color-mix(in oklch, var(--secondary) 38%, transparent)');
  expect(dark['--liquid-glass-bg-hover']).toBe('color-mix(in oklch, var(--secondary) 52%, transparent)');
  const own = themeToCssVars({ light: { secondary: 'red', '--liquid-glass-bg': 'pink' }, vars: { '--liquid-glass-bg-hover': 'teal' } });
  expect(own.light['--liquid-glass-bg']).toBe('pink');
  expect(own.light['--liquid-glass-bg-hover']).toBe('teal');
});

test('borderWidth sets --border-width in both modes', () => {
  expect(themeToCssVars({ borderWidth: '2px' })).toEqual({ light: { '--border-width': '2px' }, dark: { '--border-width': '2px' } });
});
