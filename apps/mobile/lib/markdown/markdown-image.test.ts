import { describe, expect, test } from 'bun:test';
import { describeMarkdownImage, groupImageBlocks, imageOnlyBlock } from './markdown-image';

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

describe('imageOnlyBlock', () => {
  test('reads the images of a block that holds only images', () => {
    expect(imageOnlyBlock('![Chart](/workspace/a.png)')).toEqual([{ src: '/workspace/a.png', alt: 'Chart' }]);
    expect(imageOnlyBlock('![a](x.png)\n![b](https://cdn.example.com/y.png "Title")  ![](z.png)')).toEqual([
      { src: 'x.png', alt: 'a' },
      { src: 'https://cdn.example.com/y.png', alt: 'b' },
      { src: 'z.png', alt: '' },
    ]);
  });

  test('is null for any block with other content', () => {
    expect(imageOnlyBlock('Here is the chart: ![a](x.png)')).toBeNull();
    expect(imageOnlyBlock('[link](x.png)')).toBeNull();
    expect(imageOnlyBlock('')).toBeNull();
  });
});

describe('groupImageBlocks', () => {
  test('merges a run of image-only blocks with two or more images into one gallery', () => {
    expect(groupImageBlocks(['Intro', '![a](a.png)', '![b](b.png)', 'Outro'])).toEqual([
      { kind: 'markdown', index: 0, text: 'Intro' },
      { kind: 'gallery', index: 1, last: 2, images: [{ src: 'a.png', alt: 'a' }, { src: 'b.png', alt: 'b' }] },
      { kind: 'markdown', index: 3, text: 'Outro' },
    ]);
  });

  test('a block with several images is a gallery on its own', () => {
    expect(groupImageBlocks(['![a](a.png) ![b](b.png)'])).toEqual([
      { kind: 'gallery', index: 0, last: 0, images: [{ src: 'a.png', alt: 'a' }, { src: 'b.png', alt: 'b' }] },
    ]);
  });

  test('a single image stays markdown, rendered inline', () => {
    expect(groupImageBlocks(['Text', '![a](a.png)'])).toEqual([
      { kind: 'markdown', index: 0, text: 'Text' },
      { kind: 'markdown', index: 1, text: '![a](a.png)' },
    ]);
  });
});
