import { describe, expect, test } from 'bun:test';

import { repoPageSection, repoPageTabs, type RepoPageSection } from './project-repo-page';

/**
 * The merged Repo page (KRTX-2444): one git-focused surface at /files whose
 * two sections are the repo file browser and the Review Center inbox. These
 * tests pin the navigation rules that decide which sections a viewer gets,
 * because one of them is a real stranding hazard: the repo read leaf
 * (`project.file.read`) is editor-tier, while the review inbox has always
 * been open to plain members (`project.review.read` is floor-tier). A merge
 * that gated the whole page on the files read would erase Review for every
 * plain member.
 */
describe('repoPageSection', () => {
  test('the repo section shows the file browser to a caller who may read files', () => {
    expect(repoPageSection('repo', true)).toBe('repo');
  });

  test('the review section shows the inbox regardless of the files read', () => {
    expect(repoPageSection('review', true)).toBe('review');
    expect(repoPageSection('review', false)).toBe('review');
  });

  test('a viewer without project.file.read gets the review inbox, not a broken repo body', () => {
    // The old /files page showed its own empty/error state to a plain member;
    // the member never saw that page (the row hid). Now the row opens for
    // them too, so the body must fall back to the section they can use.
    expect(repoPageSection('repo', false)).toBe('review');
  });
});

describe('repoPageTabs', () => {
  const TABS = (section: RepoPageSection, repoOpen: boolean) =>
    repoPageTabs({
      projectId: 'p1',
      section,
      repoOpen,
      repoLabel: 'Repo',
      reviewLabel: 'Review',
    });

  test('both sections show for a caller who may read files, repo first', () => {
    const tabs = TABS('repo', true);
    expect(tabs.map((t) => t.label)).toEqual(['Repo', 'Review']);
    expect(tabs.map((t) => t.href)).toEqual(['/projects/p1/files', '/projects/p1/files/review']);
    expect(tabs.find((t) => t.key === 'repo')?.active).toBe(true);
    expect(tabs.find((t) => t.key === 'review')?.active).toBe(false);
  });

  test('the active tab follows the section, not the permission', () => {
    const tabs = TABS('review', true);
    expect(tabs.find((t) => t.key === 'repo')?.active).toBe(false);
    expect(tabs.find((t) => t.key === 'review')?.active).toBe(true);
  });

  test('a review-only viewer sees one tab, and it is the active one', () => {
    // Composed exactly as the page calls them: the fallback section decides
    // the body AND the bar.
    const section = repoPageSection('repo', false);
    const tabs = repoPageTabs({
      projectId: 'p1',
      section,
      repoOpen: false,
      repoLabel: 'Repo',
      reviewLabel: 'Review',
    });
    expect(tabs.map((t) => t.label)).toEqual(['Review']);
    expect(tabs[0]?.active).toBe(true);
  });
});
