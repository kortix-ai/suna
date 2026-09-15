import { expect, test } from 'bun:test';
import { readYamlAgentBehavior, updateYamlAgentBehavior } from './agent-config-editor';

test('YAML editor resolves a prompt file without interpreting its frontmatter', async () => {
  const reads: string[] = [];
  const behavior = await readYamlAgentBehavior(
    { model: 'provider/model', prompt: { file: 'prompts/a.md' }, pi: { source: 'code/a.ts' } },
    async (path) => {
      reads.push(path);
      return '---\nmodel: prompt text\n---\nHello';
    },
  );
  expect(reads).toEqual(['prompts/a.md']);
  expect(behavior).toEqual({
    model: 'provider/model',
    prompt: '---\nmodel: prompt text\n---\nHello',
  });
});

test('YAML editor fails if the declared prompt cannot be read', async () => {
  await expect(
    readYamlAgentBehavior({ prompt: { file: 'missing.md' } }, async () => {
      throw new Error('not found');
    }),
  ).rejects.toThrow('not found');
});

test('YAML editor updates inline behavior and preserves custom source and disable', () => {
  const existing = {
    model: 'old/model',
    temperature: 0.2,
    prompt: 'old',
    disable: true,
    pi: { source: 'code/a.ts' },
  };
  const result = updateYamlAgentBehavior(existing, { model: 'new/model', prompt: 'new' });
  expect(result).toEqual({
    config: { model: 'new/model', prompt: 'new', disable: true, pi: { source: 'code/a.ts' } },
    file: null,
  });
  expect(existing.prompt).toBe('old');
});

test('YAML editor keeps the file reference when replacing or clearing its contents', () => {
  const existing = { prompt: { file: 'prompts/a.md' }, pi: { source: 'code/a.ts' } };
  const result = updateYamlAgentBehavior(existing, { prompt: '' });
  expect(result).toEqual({ config: existing, file: { path: 'prompts/a.md', content: '' } });
});

test('empty explicit configuration stays independent of legacy files', async () => {
  expect(
    await readYamlAgentBehavior({}, async () => {
      throw new Error('must not read');
    }),
  ).toEqual({});
  expect(updateYamlAgentBehavior({}, {})).toEqual({ config: {}, file: null });
});
