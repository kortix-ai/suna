import { TooltipProvider } from '@/components/ui/tooltip';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectIconPicker } from './project-icon-picker';

describe('ProjectIconPicker', () => {
  test('renders both tab triggers, Emoji first', () => {
    // Wrapped in TooltipProvider: the Emoji tab is the default active panel,
    // and EmojiPicker wraps its skin-tone selector in Hint (components/ui/hint.tsx),
    // which throws `Tooltip must be used within TooltipProvider` without one —
    // see outputs-card.test.tsx / snapshots-tab.test.tsx for the same house fix.
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ProjectIconPicker onEmojiSelect={() => {}} onGlyphSelect={() => {}} />
      </TooltipProvider>,
    );
    expect(html).toContain('Emoji');
    expect(html).toContain('Icon');
    expect(html.indexOf('Emoji')).toBeLessThan(html.indexOf('Icon'));
  });

  test('does not modify the emoji picker', () => {
    // The wrapper composes EmojiPicker as-is. If someone forks it to add tab
    // chrome, this catches it.
    const source = readFileSync(new URL('./project-icon-picker.tsx', import.meta.url), 'utf8');
    expect(source).toContain('<EmojiPicker');
  });
});
