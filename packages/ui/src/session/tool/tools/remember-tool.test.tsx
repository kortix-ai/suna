import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { IntlTestProvider } from '../../../test-utils/intl';
import { type RememberLine, RememberLineView, rememberLine } from './remember-tool';

const result = {
  saved: true,
  page_id: 'page-1',
  version_id: 'version-1',
  layer: { layer_id: 'layer-1', version: '3', scope: 'channel', name: '#marketing', key: 'space-1' },
  title: 'Q4 launch',
  status: 'confirmed',
  created: false,
  merged: true,
  copy_path: '/opt/kortix/memory/channel/workstreams/q4-launch.md',
};

describe('rememberLine', () => {
  test('a call still running is "running"', () => {
    expect(rememberLine('running', '')).toEqual({ state: 'running' });
    expect(rememberLine('pending', '')).toEqual({ state: 'running' });
  });

  test('the API result is "saved" with page, version, title and layer', () => {
    expect(rememberLine('completed', JSON.stringify(result))).toEqual({
      state: 'saved',
      pageId: 'page-1',
      versionId: 'version-1',
      title: 'Q4 launch',
      layer: { scope: 'channel', name: '#marketing', key: 'space-1' },
    });
  });

  test('a refusal is "failed" with the message, without the code', () => {
    expect(rememberLine('completed', 'Error: secret_detected: That looks like a secret.')).toEqual({
      state: 'failed',
      reason: 'That looks like a secret.',
    });
    expect(rememberLine('error', '', 'memory is unavailable (503)')).toEqual({
      state: 'failed',
      reason: 'memory is unavailable (503)',
    });
  });

  test('text that is not the result falls back to the default row', () => {
    expect(rememberLine('completed', 'saved it')).toEqual({ state: 'other' });
    expect(rememberLine('completed', JSON.stringify({ ...result, layer: { ...result.layer, scope: 'team' } }))).toEqual({
      state: 'other',
    });
    expect(rememberLine('completed', JSON.stringify({ saved: true }))).toEqual({ state: 'other' });
  });
});

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={() => {}}>
      {node}
    </IntlTestProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
const saved = rememberLine('completed', JSON.stringify(result)) as Extract<RememberLine, { state: 'saved' }>;

describe('RememberLineView', () => {
  test('running: "Saving to memory…", no actions', () => {
    const html = render(<RememberLineView line={{ state: 'running' }} viewHref={null} undo="idle" onUndo={() => {}} />);
    expect(text(html)).toContain('Saving to memory…');
    expect(html).not.toContain('<button');
  });

  test('saved in a channel: the layer and title, View to the Memory tab, Undo', () => {
    const html = render(
      <RememberLineView line={saved} viewHref="/projects/p/c/marketing?tab=memory&page=page-1" undo="idle" onUndo={() => {}} />,
    );
    expect(text(html)).toContain('Saved to #marketing memory: Q4 launch');
    expect(html).toContain('href="/projects/p/c/marketing?tab=memory&amp;page=page-1"');
    expect(text(html)).toContain('View');
    expect(html).toMatch(/<button[^>]*>Undo<\/button>/);
  });

  test('saved in a DM and in Company memory name their layer', () => {
    const dm = { ...saved, layer: { ...saved.layer, scope: 'dm', name: 'Writer' } } as typeof saved;
    const company = { ...saved, layer: { ...saved.layer, scope: 'company', name: 'Company' } } as typeof saved;
    expect(text(render(<RememberLineView line={dm} viewHref={null} undo="idle" onUndo={() => {}} />))).toContain(
      'Saved to your memory with Writer: Q4 launch',
    );
    expect(text(render(<RememberLineView line={company} viewHref={null} undo="idle" onUndo={() => {}} />))).toContain(
      'Saved to Company memory: Q4 launch',
    );
  });

  test('undone: the line reads "Undone" and offers nothing', () => {
    const html = render(<RememberLineView line={saved} viewHref="/x" undo="undone" onUndo={() => {}} />);
    expect(text(html)).toContain('Undone');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('href=');
  });

  test('superseded: "Changed since" and a way to History, no Undo', () => {
    const html = render(<RememberLineView line={saved} viewHref="/x" undo="superseded" onUndo={() => {}} />);
    expect(text(html)).toContain('Changed since');
    expect(text(html)).toContain('open History');
    expect(html).not.toContain('<button');
  });

  test('failed: "Not saved to memory: <reason>"', () => {
    const html = render(
      <RememberLineView line={{ state: 'failed', reason: 'That looks like a secret.' }} viewHref={null} undo="idle" onUndo={() => {}} />,
    );
    expect(text(html)).toContain('Not saved to memory: That looks like a secret.');
  });
});
