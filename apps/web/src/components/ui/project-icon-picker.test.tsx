import { TooltipProvider } from '@/components/ui/tooltip';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('ProjectIconPicker loading', () => {
  // The settings panel is mounted on every project page (project-shell.tsx),
  // and its General tab renders ProjectIconField -> ProjectIconPicker. A
  // static import of either panel put frimousse and the 202-glyph registry in
  // the project home's largest chunk (338 KB decoded on dev, 2026-09-27).
  test('loads the emoji and glyph panels on demand, not with the picker', () => {
    const source = readFileSync(join(import.meta.dir, 'project-icon-picker.tsx'), 'utf8');
    expect(source).not.toMatch(/^import \{[^}]*\bEmojiPicker\b[^}]*\} from '@\/components\/ui\/emoji-picker';$/m);
    expect(source).not.toMatch(/^import \{[^}]*\bGlyphPicker\b[^}]*\} from '@\/components\/ui\/glyph-picker';$/m);
    expect(source).toContain("import('@/components/ui/emoji-picker')");
    expect(source).toContain("import('@/components/ui/glyph-picker')");
  });

  test('the icon field trigger draws its glyph without the registry', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', '..', 'features', 'projects', 'modal', 'project-icon-field.tsx'),
      'utf8',
    );
    expect(source).not.toContain('glyph-registry');
  });
});
