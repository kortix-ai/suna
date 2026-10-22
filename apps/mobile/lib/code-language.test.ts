import { expect, test } from 'bun:test';
import { languageLabel, normalizeLanguage } from './code-theme';

const cases = [
  ['htm', 'html', 'html'],
  ['js', 'javascript', 'javascript'],
  ['node', 'javascript', 'javascript'],
  ['mjs', 'javascript', 'javascript'],
  ['cjs', 'javascript', 'javascript'],
  ['ts', 'typescript', 'typescript'],
  ['mts', 'typescript', 'typescript'],
  ['cts', 'typescript', 'typescript'],
  ['sass', 'scss', 'scss'],
  ['svg', 'xml', 'svg'],
  ['py', 'python', 'python'],
  ['py3', 'python', 'python'],
  ['python3', 'python', 'python'],
  ['rb', 'ruby', 'ruby'],
  ['rs', 'rust', 'rust'],
  ['golang', 'go', 'go'],
  ['kt', 'kotlin', 'kotlin'],
  ['kts', 'kotlin', 'kotlin'],
  ['cs', 'csharp', 'csharp'],
  ['c#', 'csharp', 'c#'],
  ['c++', 'cpp', 'c++'],
  ['cxx', 'cpp', 'cxx'],
  ['hpp', 'cpp', 'hpp'],
  ['ex', 'elixir', 'elixir'],
  ['exs', 'elixir', 'elixir'],
  ['sh', 'bash', 'bash'],
  ['shell', 'bash', 'bash'],
  ['zsh', 'bash', 'bash'],
  ['console', 'bash', 'console'],
  ['shell-session', 'bash', 'shell-session'],
  ['ps1', 'powershell', 'powershell'],
  ['pwsh', 'powershell', 'powershell'],
  ['docker', 'dockerfile', 'dockerfile'],
  ['make', 'makefile', 'makefile'],
  ['mk', 'makefile', 'makefile'],
  ['tf', 'terraform', 'terraform'],
  ['tfvars', 'terraform', 'terraform'],
  ['yml', 'yaml', 'yaml'],
  ['md', 'markdown', 'markdown'],
  ['mdown', 'markdown', 'markdown'],
  ['jsonl', 'json', 'jsonl'],
  ['ndjson', 'json', 'ndjson'],
  ['env', 'dotenv', 'dotenv'],
  ['patch', 'diff', 'patch'],
  ['gql', 'graphql', 'graphql'],
  ['protobuf', 'proto', 'proto'],
  ['psql', 'sql', 'psql'],
  ['postgres', 'sql', 'postgres'],
  ['postgresql', 'sql', 'postgresql'],
  ['mysql', 'sql', 'mysql'],
  ['sqlite', 'sql', 'sqlite'],
  ['txt', 'text', 'text'],
  ['plain', 'text', 'text'],
  ['plaintext', 'text', 'text'],
] as const;

for (const [hint, grammar, caption] of cases) {
  test(`language hint ${hint}`, () => {
    expect(normalizeLanguage(hint)).toBe(grammar);
    expect(normalizeLanguage(hint.toUpperCase())).toBe(grammar);
    expect(languageLabel(hint)).toBe(caption);
    expect(languageLabel(hint.toUpperCase())).toBe(caption);
  });
}

test('empty, unknown and host whitespace behavior', () => {
  expect(normalizeLanguage('')).toBe('');
  expect(languageLabel('')).toBe('text');
  expect(normalizeLanguage('Not-A-Grammar')).toBe('not-a-grammar');
  expect(languageLabel('Not-A-Grammar')).toBe('not-a-grammar');
  expect(normalizeLanguage('   ')).toBe('');
  expect(languageLabel('   ')).toBe('');
  expect(normalizeLanguage(' TS ')).toBe('typescript');
  expect(languageLabel(' TS ')).toBe('typescript');
  expect(normalizeLanguage(' PSQL ')).toBe('sql');
  expect(languageLabel(' PSQL ')).toBe('psql');
  expect(normalizeLanguage(' Unknown ')).toBe('unknown');
  expect(languageLabel(' Unknown ')).toBe('unknown');
});
