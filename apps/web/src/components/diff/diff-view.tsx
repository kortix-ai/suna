'use client';

import React, { useMemo } from 'react';
import { useTheme } from 'next-themes';
import { PatchDiff } from '@pierre/diffs/react';
import type { FileDiffOptions } from '@pierre/diffs';
import { createTwoFilesPatch } from 'diff';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Shared `DiffView` — single replacement for every custom diff renderer in
// the app. Wraps @pierre/diffs' React `PatchDiff` with project-wide defaults:
//   • Pierre's bundled themes (light/dark switch driven by next-themes)
//   • Split layout by default with caller-overridable layout/indicator props
//   • Word-level inline highlighting so character-level edits read clearly
// ---------------------------------------------------------------------------

type DiffLayout = 'unified' | 'split';
type DiffIndicators = 'classic' | 'bars' | 'none';
type InlineHighlight = 'word-alt' | 'word' | 'char' | 'none';

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
    if ('patch' in props) return props.patch;
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

  const options = useMemo<FileDiffOptions<undefined>>(() => ({
    theme: { dark: 'pierre-dark', light: 'pierre-light' },
    themeType,
    diffStyle: props.layout ?? 'split',
    diffIndicators: props.indicators ?? 'bars',
    disableFileHeader: props.hideFileHeader ?? false,
    disableLineNumbers: props.hideLineNumbers ?? false,
    disableBackground: props.flatBackground ?? false,
    overflow: props.wrap ? 'wrap' : 'scroll',
    lineDiffType: props.inlineHighlight ?? 'word',
  }), [
    themeType,
    props.layout,
    props.indicators,
    props.hideFileHeader,
    props.hideLineNumbers,
    props.flatBackground,
    props.wrap,
    props.inlineHighlight,
  ]);

  return (
    <PatchDiff
      patch={patch}
      options={options}
      className={cn('kortix-diff-view text-sm leading-[1.55]', props.className)}
    />
  );
}
