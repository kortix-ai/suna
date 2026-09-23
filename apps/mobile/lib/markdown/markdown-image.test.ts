import { describe, expect, test } from 'bun:test';
import { describeMarkdownImage } from './markdown-image';

describe('describeMarkdownImage', () => {
  test('labels a remote image with its alt text and links to it', () => {
    expect(describeMarkdownImage('https://cdn.example.com/chart.png', 'Revenue chart')).toEqual({
      label: 'Revenue chart',
      href: 'https://cdn.example.com/chart.png',
    });
  });

  test('falls back to the host when the alt text is empty', () => {
    expect(describeMarkdownImage('https://attacker.example/p?d=secret', '')).toEqual({
      label: 'attacker.example',
      href: 'https://attacker.example/p?d=secret',
    });
    expect(describeMarkdownImage('HTTP://Img.Example.com:8080/a.png', '   ')).toEqual({
      label: 'img.example.com:8080',
      href: 'HTTP://Img.Example.com:8080/a.png',
    });
  });

  test('drops credentials from the host label', () => {
    expect(describeMarkdownImage('https://user:pass@host.example/x.png', undefined).label).toBe(
      'host.example',
    );
  });

  test('trims the source before linking', () => {
    expect(describeMarkdownImage('  https://a.example/x.png ', 'x').href).toBe('https://a.example/x.png');
  });

  test('data images get a placeholder without a link', () => {
    expect(describeMarkdownImage('data:image/png;base64,iVBORw0KGgo=', 'Screenshot')).toEqual({
      label: 'Screenshot',
      href: null,
    });
    expect(describeMarkdownImage('DATA:image/gif;base64,R0lGOD', '')).toEqual({
      label: 'Image',
      href: null,
    });
  });

  test('non-http sources and relative paths get no link', () => {
    expect(describeMarkdownImage('attacker.example/x.png', '')).toEqual({ label: 'Image', href: null });
    expect(describeMarkdownImage('javascript:alert(1)', 'x')).toEqual({ label: 'x', href: null });
    expect(describeMarkdownImage('file:///sdcard/a.png', '')).toEqual({ label: 'Image', href: null });
    expect(describeMarkdownImage('mailto:a@b.c', '')).toEqual({ label: 'Image', href: null });
  });

  test('missing or non-string attributes are handled', () => {
    expect(describeMarkdownImage(undefined, undefined)).toEqual({ label: 'Image', href: null });
    expect(describeMarkdownImage(null, 7)).toEqual({ label: 'Image', href: null });
  });

  test('collapses whitespace in long alt text', () => {
    expect(describeMarkdownImage('https://a.example/x.png', '  A\n  multi   line\talt ').label).toBe(
      'A multi line alt',
    );
  });
});
