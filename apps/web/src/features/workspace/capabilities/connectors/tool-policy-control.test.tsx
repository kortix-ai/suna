import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';

import { ToolPolicyControl } from './tool-policy-control';

const render = (markup: React.ReactElement) =>
  renderToStaticMarkup(<TooltipProvider>{markup}</TooltipProvider>);

describe('ToolPolicyControl', () => {
  test('all three decisions are always offered', () => {
    const markup = render(
      <ToolPolicyControl value="default" onChange={() => {}} label="Permission for a" />,
    );
    expect(markup).toContain('Block');
    expect(markup).toContain('Ask');
    expect(markup).toContain('Allow');
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

  // Four states, three segments. Faking the fourth by lighting up Allow would
  // claim a choice nobody made.
  test('a default choice presses nothing', () => {
    const markup = render(
      <ToolPolicyControl value="default" onChange={() => {}} label="Permission for a" />,
    );
    expect(markup).not.toContain('aria-pressed="true"');
  });

  test('a project-locked tool disables every segment', () => {
    const markup = render(
      <ToolPolicyControl
        value="block"
        onChange={() => {}}
        label="Permission for a"
        lockedReason="A project rule already decides this tool."
      />,
    );
    expect(markup.match(/disabled=""/g)).toHaveLength(3);
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
