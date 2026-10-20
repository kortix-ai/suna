import { describe, expect, test } from 'bun:test';
import { reportMarkdown } from '../../src/lib/report-markdown';

describe('reportMarkdown: the diligence report as a file that reads outside Lumen', () => {
  test('citation links become (filename, p. N); red flags come first, by label', () => {
    const c = { documentId: 'd1', filename: 'msa-example.pdf', page: 2 };
    const md = reportMarkdown('Due diligence: Example', {
      redFlags: [{ title: 'Uncapped liability', severity: 'high', filename: 'msa-example.pdf', citations: [c] }],
      sections: [{ heading: 'Liability', bodyMd: 'The MSA has no cap [1](/cite?d=d1&a=p2.4&q=no%20cap).', citations: [c] }],
    });
    expect(md).toBe(
      '# Due diligence: Example\n\n## Red flags\n\n- **High**: Uncapped liability (msa-example.pdf, p. 2)\n\n## Liability\n\nThe MSA has no cap (msa-example.pdf, p. 2).\n',
    );
    expect(md).not.toContain('/cite?');
  });
});
