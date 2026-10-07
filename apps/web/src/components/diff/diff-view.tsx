'use client';

import { SHIKI_THEME_DARK, SHIKI_THEME_LIGHT } from '@/lib/code-theme';
import { cn } from '@/lib/utils';
import type { FileDiffOptions } from '@pierre/diffs';
import { PatchDiff } from '@pierre/diffs/react';
import { createTwoFilesPatch } from 'diff';
import { useTheme } from 'next-themes';
import { useMemo } from 'react';

// ---------------------------------------------------------------------------
// Shared `DiffView` — single replacement for every custom diff renderer in
// the app. Wraps @pierre/diffs' React `PatchDiff` with project-wide defaults:
//   • the app palette from @/lib/code-theme (light/dark driven by next-themes)
//   • Split layout by default with caller-overridable layout/indicator props
//   • Word-level inline highlighting so character-level edits read clearly
// ---------------------------------------------------------------------------

export type DiffLayout = 'unified' | 'split';
export type DiffIndicators = 'classic' | 'bars' | 'none';
export type InlineHighlight = 'word-alt' | 'word' | 'char' | 'none';

/**
 * Pierre renders a one-sided diff — a new file (only `+` lines) or a deleted
 * one (only `−` lines) — as a single column in BOTH layouts: it excludes the
 * empty side when it parsed the file as `new`/`deleted`, which it reads from
 * the `new file mode` / `deleted file mode` header line. A change set of new
 * files then shows the same rendering in stacked and side-by-side, and the
 * layout toggle does nothing on it. Dropping that header line keeps every
 * hunk byte-identical but makes Pierre parse the file as a change, so split
 * gets its empty counterpart column (the GitHub layout); unified renders
 * identically either way. Only a real git metadata line matches — content
 * lines start with `+`, `-` or a space, never at column 0.
 */
export function splitablePatch(patch: string): string {
  return patch.replace(/^(?:new|deleted) file mode .*\n?/gm, '');
}

interface DiffViewCommonProps {
  layout?: DiffLayout;
  /** Hide the per-file header rendered by Pierre's chrome. */
  hideFileHeader?: boolean;
  /** Hide the line-number gutter. */
  hideLineNumbers?: boolean;
  /** Wrap long lines instead of horizontal scrolling. */
  wrap?: boolean;
  /** Inline change marker style — defaults to word-level. */
  inlineHighlight?: InlineHighlight;
  /** +/- indicator style — defaults to thin colour bars. */
  indicators?: DiffIndicators;
  /** Remove the green/red row background tints. */
  flatBackground?: boolean;
  className?: string;
}

interface PatchProps extends DiffViewCommonProps {
  /** Unified-diff patch string (output of `createTwoFilesPatch`, `git diff`, etc). */
  patch: string;
}

interface FilesProps extends DiffViewCommonProps {
  /** Old / new file pair — converted to a unified patch under the hood. */
  before: { name: string; contents: string };
  after: { name: string; contents: string };
}

export function DiffView(props: PatchProps | FilesProps) {
  const { resolvedTheme } = useTheme();
  const themeType = resolvedTheme === 'dark' ? 'dark' : 'light';

  const patch = useMemo(() => {
    // `createTwoFilesPatch` writes no `new file mode` / `deleted file mode`
    // line, so only the patch path can be one-sided.
    if ('patch' in props) return splitablePatch(props.patch);
    return createTwoFilesPatch(
      props.before.name,
      props.after.name,
      props.before.contents,
      props.after.contents,
      '',
      '',
    );
  }, [
    'patch' in props ? props.patch : null,
    'before' in props ? props.before.name : null,
    'before' in props ? props.before.contents : null,
    'after' in props ? props.after.name : null,
    'after' in props ? props.after.contents : null,
  ]);

  const options = useMemo<FileDiffOptions<undefined>>(
    () => ({
      theme: { dark: SHIKI_THEME_DARK, light: SHIKI_THEME_LIGHT },
      themeType,
      diffStyle: props.layout ?? 'split',
      diffIndicators: props.indicators ?? 'bars',
      disableFileHeader: props.hideFileHeader ?? false,
      disableLineNumbers: props.hideLineNumbers ?? false,
      disableBackground: props.flatBackground ?? false,
      overflow: props.wrap ? 'wrap' : 'scroll',
      lineDiffType: props.inlineHighlight ?? 'word',
    }),
    [
      themeType,
      props.layout,
      props.indicators,
      props.hideFileHeader,
      props.hideLineNumbers,
      props.flatBackground,
      props.wrap,
      props.inlineHighlight,
    ],
  );

  return (
    <PatchDiff
      patch={patch}
      options={options}
      className={cn('kortix-diff-view text-[0.8rem] leading-[1.55]', props.className)}
    />
  );
}
