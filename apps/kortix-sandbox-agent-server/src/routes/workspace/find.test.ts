import { describe, expect, test } from 'bun:test'

import { parseRipgrepJson } from './find'

// Real `rg --json --max-count 50 -- needle .` output (ripgrep 14.1).
const RG_OUTPUT = [
  '{"type":"begin","data":{"path":{"text":"./src/a.ts"}}}',
  '{"type":"match","data":{"path":{"text":"./src/a.ts"},"lines":{"text":"hello needle\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":6,"end":12}]}}',
  '{"type":"end","data":{"path":{"text":"./src/a.ts"},"binary_offset":null,"stats":{"matches":1}}}',
  '{"type":"summary","data":{"elapsed_total":{"secs":0,"nanos":1,"human":"0s"},"stats":{"matches":1}}}',
  '',
].join('\n')

describe('parseRipgrepJson', () => {
  test('returns workspace-relative paths, same as the Node fallback', () => {
    expect(parseRipgrepJson(RG_OUTPUT)).toEqual([
      {
        path: 'src/a.ts',
        lines: 'hello needle\n',
        line_number: 1,
        absolute_offset: 0,
        submatches: [{ start: 6, end: 12 }],
      },
    ])
  })

  test('keeps a path that has no ./ prefix and skips non-JSON lines', () => {
    const out = parseRipgrepJson(
      'not json\n{"type":"match","data":{"path":{"text":"b.md"},"lines":{"text":"x"},"line_number":2,"absolute_offset":4,"submatches":[]}}\n',
    )
    expect(out.map((m) => m.path)).toEqual(['b.md'])
  })
})
