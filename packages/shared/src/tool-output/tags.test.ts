import { describe, expect, test } from 'bun:test';
import { ptyOutputBlock, ptySpawnedBody, stripBashMetadata } from './tags';
import { chooser, within } from './testing';

// The regexes the tool renderers ran, kept ONLY as parity oracles.
const legacyStrip = (text: string) => text.replace(/<bash_metadata>[\s\S]*?<\/bash_metadata>/g, '');
function legacyPty(output: string) {
  const match = output.match(/<pty_output\s+([^>]*)>([\s\S]*?)<\/pty_output>/);
  return match ? { attrs: match[1], body: match[2] } : null;
}
const legacySpawned = (output: string) =>
  output.match(/<pty_spawned>([\s\S]*?)<\/pty_spawned>/)?.[1] ?? null;

describe('stripBashMetadata', () => {
  test('removes what the regex removed on 3000 random outputs', () => {
    const { pick, some } = chooser(11);
    const noise = [
      'exit 0',
      '\n',
      ' ',
      '>',
      '<',
      'x',
      '<BASH_METADATA>',
      '</bash_metadata >',
      '<bash_metadata',
      '</bash_metadata',
    ];
    let stripped = 0;
    for (let i = 0; i < 3000; i++) {
      // Blocks that open, close, or both, between random noise.
      let text = some(noise, 3);
      for (let block = 0, count = pick([1, 2, 3]); block < count; block++) {
        text += pick(['<bash_metadata>', '<bash_metadata>', '<bash_metadata', '']) + some(noise, 3);
        text +=
          pick(['</bash_metadata>', '</bash_metadata>', '</bash_metadata', '']) + some(noise, 3);
      }
      const expected = legacyStrip(text);
      expect(stripBashMetadata(text)).toBe(expected);
      if (expected !== text) stripped++;
    }
    expect(stripped).toBeGreaterThan(600);
  });

  test('keeps the output around each block', () => {
    const output =
      'total 0\n<bash_metadata>\nexit code 0\n</bash_metadata>\ndone<bash_metadata>x</bash_metadata>';
    expect(stripBashMetadata(output)).toBe('total 0\n\ndone');
    expect(stripBashMetadata('<bash_metadata>never closed')).toBe('<bash_metadata>never closed');
  });
});

describe('ptyOutputBlock', () => {
  test('reads what the regex read on 3000 random outputs', () => {
    const { pick, some } = chooser(12);
    const noise = [
      '<pty_output',
      '</pty_output',
      '>',
      '\n',
      ' ',
      'x',
      '<pty_outputx>',
      '00001| ls',
    ];
    let found = 0;
    for (let i = 0; i < 3000; i++) {
      let text = some(noise, 3);
      for (let block = 0, count = pick([1, 2, 3]); block < count; block++) {
        text +=
          pick(['<pty_output', '<pty_output', '<pty_outputx']) +
          some([' ', '\n', '\t', '\u00a0'], 2);
        text += some([' id="a"', ' status="exited"', 'x', '<'], 2) + pick(['>', '>', '']);
        text += some(['00001| ls', '\n', ' ', '(End of buffer)', '<', '>'], 3);
        text += pick(['</pty_output>', '</pty_output>', '</pty_output', '']) + some(noise, 2);
      }
      const expected = legacyPty(text);
      expect(ptyOutputBlock(text)).toEqual(expected);
      if (expected) found++;
    }
    expect(found).toBeGreaterThan(600);
  });

  test('reads the id, the status and the buffer', () => {
    const output =
      '<pty_output id="pty_1" status="running">\n00001| $ ls\n(End of buffer)\n</pty_output>';
    expect(ptyOutputBlock(output)).toEqual({
      attrs: 'id="pty_1" status="running"',
      body: '\n00001| $ ls\n(End of buffer)\n',
    });
    expect(ptyOutputBlock('<pty_output>no attributes</pty_output>')).toBeNull();
  });
});

describe('ptySpawnedBody', () => {
  test('reads what the regex read on 3000 random outputs', () => {
    const { pick, some } = chooser(13);
    const noise = ['<pty_spawned', '</pty_spawned', 'ID: pty_1', '\n', ' ', '>', 'x'];
    let found = 0;
    for (let i = 0; i < 3000; i++) {
      let text = some(noise, 3);
      for (let block = 0, count = pick([1, 2, 3]); block < count; block++) {
        text += pick(['<pty_spawned>', '<pty_spawned>', '<pty_spawned']) + some(noise, 3);
        text += pick(['</pty_spawned>', '</pty_spawned>', '</pty_spawned', '']) + some(noise, 2);
      }
      const expected = legacySpawned(text);
      expect(ptySpawnedBody(text)).toBe(expected);
      if (expected !== null) found++;
    }
    expect(found).toBeGreaterThan(600);
  });
});

describe('no tool output can freeze a renderer', () => {
  within('stripBashMetadata: 16k openers that never close (240k characters)', () =>
    stripBashMetadata('<bash_metadata>'.repeat(16_000)),
  );
  within('ptyOutputBlock: 17k openers that never close (238k characters)', () =>
    ptyOutputBlock('<pty_output x>'.repeat(17_000)),
  );
  within('ptyOutputBlock: one opener, 240k spaces, no >', () =>
    ptyOutputBlock(`<pty_output${' '.repeat(240_000)}x`),
  );
  within('ptySpawnedBody: 18k openers that never close (240k characters)', () =>
    ptySpawnedBody('<pty_spawned>'.repeat(18_500)),
  );
});
