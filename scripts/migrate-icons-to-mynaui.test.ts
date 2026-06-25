import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transformSource } from './migrate-icons-to-mynaui';

const FIXTURE = readFileSync(join(import.meta.dir, '__fixtures__', 'test.tsx'), 'utf8');

describe('transformSource', () => {
  const { code, notes } = transformSource('test.tsx', FIXTURE);

  test('removes every lucide-react and react-icons import specifier', () => {
    expect(code).not.toMatch(/from\s+['"]lucide-react['"]/);
    expect(code).not.toMatch(/from\s+['"]react-icons\//);
  });

  test('uses the regular (outline) variant by default, aliased to the original local name', () => {
    expect(code).toContain('Dots as MoreHorizontal'); // default → outline
    expect(code).not.toMatch(/DotsSolid/);
    expect(code).toContain('Key as KeyRound'); // default → outline
    expect(code).not.toMatch(/KeySolid/);
  });

  test('uses Solid only for FORCE_SOLID bases (CogOne/Settings, Trash)', () => {
    expect(code).toContain('CogOneSolid as Settings');
    expect(code).toContain('TrashSolid as Trash2');
  });

  test('a direct-match outline icon needs no alias', () => {
    expect(code).toMatch(/\bCalendar\b/);
    expect(code).not.toMatch(/CalendarSolid/);
  });

  test('preserves a pre-existing local alias', () => {
    expect(code).toContain('CogOneSolid as SettingsAlias');
  });

  test('migrates react-icons (brand + fill) to mynaui regular by default', () => {
    expect(code).toContain('Github as SiGithub');
    expect(code).toContain('Sparkles as HiMiniSparkles');
  });

  test('swaps LucideIcon and react-icons IconType to the mynaui Icon type', () => {
    expect(code).toMatch(/import type \{[^}]*Icon as LucideIcon[^}]*\} from ['"]@mynaui\/icons-react['"]/);
    expect(code).toMatch(/import type \{[^}]*Icon as IconType[^}]*\} from ['"]@mynaui\/icons-react['"]/);
  });

  test('rewrites lucide-react/dynamic to the mynaui-backed resolver', () => {
    expect(code).toContain("from '@/components/ui/dynamic-icon'");
    expect(code).toContain('DynamicIcon');
  });

  test('leaves component bodies untouched (identifiers preserved via aliasing)', () => {
    expect(code).toContain('<Settings />');
    expect(code).toContain('<Trash2 />');
    expect(code).toContain('<SettingsAlias />');
    expect(code).toContain('<DynamicIcon name="message-circle" />');
    expect(code).toContain('export const iconRef: LucideIcon = Settings;');
  });

  test('flags no forced mappings for this fixture (all have clear equivalents)', () => {
    expect(notes.filter(n => n.forced)).toHaveLength(0);
  });

  test('is idempotent — re-running on migrated output is a no-op', () => {
    const second = transformSource('test.tsx', code);
    expect(second.code).toBe(code);
  });
});
