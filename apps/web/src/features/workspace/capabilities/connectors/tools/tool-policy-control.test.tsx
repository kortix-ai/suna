import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';

import { ToolPolicyControl } from './tool-policy-control';
import { POLICY_SEGMENTS } from './tool-policy-labels';

const render = (markup: React.ReactElement) =>
  renderToStaticMarkup(<TooltipProvider>{markup}</TooltipProvider>);

describe('ToolPolicyControl', () => {
  test('all four states are offered, Default first', () => {
    const markup = render(
      <ToolPolicyControl value="default" onChange={() => {}} label="Permission for a" />,
    );
    for (const label of ['Default', 'Block', 'Ask', 'Allow']) expect(markup).toContain(label);
    const order = ['Default', 'Block', 'Ask', 'Allow'].map((l) => markup.indexOf(`>${l}<`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
  });

  // Without a Default segment a tool can be set and never unset: pressing a
  // lit segment does not clear it, the bulk menu offered only the three
  // actions, and the pattern editor excludes exact rules for live tools.
  test('Default is a real choice, not only a display state', () => {
    const picked: string[] = [];
    const markup = render(
      <ToolPolicyControl value="block" onChange={(c) => picked.push(c)} label="a" />,
    );
    expect(markup).toContain('Default');
    expect(POLICY_SEGMENTS[0]?.choice).toBe('default');
    expect(picked).toEqual([]);
  });

  test('the chosen action is the only pressed segment, in its own tint', () => {
    const markup = render(
      <ToolPolicyControl value="block" onChange={() => {}} label="Permission for a" />,
    );
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(markup).toContain('text-destructive');
  });

  test('Allow is green and Ask is yellow — the shipped POLICY_LABEL tints', () => {
    expect(
      render(<ToolPolicyControl value="always_run" onChange={() => {}} label="a" />),
    ).toContain('text-kortix-green');
    expect(
      render(<ToolPolicyControl value="require_approval" onChange={() => {}} label="a" />),
    ).toContain('text-kortix-yellow');
  });

  // Following the connector default is a state the user can be IN and a choice
  // they can RETURN to. It presses its own segment — never Allow, which would
  // claim a decision nobody made.
  test('a default choice presses Default and nothing else', () => {
    const markup = render(
      <ToolPolicyControl value="default" onChange={() => {}} label="Permission for a" />,
    );
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);

    // The pressed segment is Default, and it wears no decision colour — an
    // inherited permission must never look like one the user picked.
    const pressed = [...markup.matchAll(/class="([^"]*)"[^>]*aria-pressed="true">([^<]*)</g)];
    expect(pressed).toHaveLength(1);
    const [, pressedClass, pressedLabel] = pressed[0]!;
    expect(pressedLabel).toBe('Default');
    expect(pressedClass).toContain('text-muted-foreground');
    for (const tint of ['text-kortix-green', 'text-kortix-yellow', 'text-destructive']) {
      expect(pressedClass!.split(' ').filter((c) => c === tint)).toEqual([]);
    }
  });

  test('Default carries no tint — inheriting is not a decision', () => {
    expect(POLICY_SEGMENTS[0]?.tint).toBe('text-muted-foreground');
  });

  test('a workspace-locked tool disables every segment', () => {
    const markup = render(
      <ToolPolicyControl
        value="block"
        onChange={() => {}}
        label="Permission for a"
        lockedReason="A workspace rule already decides this tool."
      />,
    );
    expect(markup.match(/disabled=""/g)).toHaveLength(4);
  });

  test('press feedback animates `scale`, which `transition-transform` does not cover', () => {
    const markup = render(<ToolPolicyControl value="block" onChange={() => {}} label="a" />);
    expect(markup).toContain('active:scale-[0.96]');
    expect(markup).toContain('transition-[color,background-color,scale]');
    // `transition-all` is a defect under the polish rules; the explicit list
    // above must win the tailwind-merge, not sit beside it.
    expect(markup).not.toContain('transition-all');
  });
});
