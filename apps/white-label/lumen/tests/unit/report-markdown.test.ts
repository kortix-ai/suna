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

describe('reportMarkdown: a citation the check did not confirm never reads as a plain reference', () => {
  const bad = { documentId: 'd1', filename: 'msa.pdf', page: 2, quote: 'capped at USD 5m', status: 'unverified' as const };
  const good = { documentId: 'd1', filename: 'msa.pdf', page: 4, quote: 'no cap applies', status: 'verified' as const };

  test('an unverified body citation and an unverified-only red flag say "not found in source"', () => {
    const md = reportMarkdown('DD', {
      sections: [{ heading: 'Liability', bodyMd: 'Capped at USD 5m [1](/cite?d=d1&a=p2.33&q=capped%20at%20USD%205m).', citations: [bad] }],
      redFlags: [{ title: 'Fabricated cap', severity: 'high', filename: 'msa.pdf', citations: [bad] }],
    });
    expect(md).toContain('Capped at USD 5m (msa.pdf, p. 2, not found in source).');
    expect(md).toContain('- **High**: Fabricated cap (msa.pdf, p. 2, not found in source)');
  });

  test('a red flag cites its first verified citation; a link the check never saw is not found', () => {
    const md = reportMarkdown('DD', {
      sections: [{ heading: 'S', bodyMd: 'A [1](/cite?d=d1&a=p4.1&q=no%20cap%20applies) B [2](/cite?d=d9&a=p7.1&q=x).', citations: [good] }],
      redFlags: [{ title: 'Uncapped', severity: 'high', filename: 'msa.pdf', citations: [bad, good] }],
    });
    expect(md).toContain('A (msa.pdf, p. 4) B (document, p. 7, not found in source).');
    expect(md).toContain('- **High**: Uncapped (msa.pdf, p. 4)\n');
  });

  test('a red flag with no citation says "no source cited", never a plain fact', () => {
    const md = reportMarkdown('DD', { redFlags: [{ title: 'Exclusivity', severity: 'high', citations: [] }] });
    expect(md).toContain('- **High**: Exclusivity (no source cited)\n');
  });
});
