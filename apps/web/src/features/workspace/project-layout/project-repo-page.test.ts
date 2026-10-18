import { describe, expect, test } from 'bun:test';
import type { CanResult } from '@/lib/use-project-can';
import { repoPageSection, repoPageTabs } from './project-repo-page';

const allow: CanResult = { allowed: true, isLoading: false, isError: false, reason: null };
const deny: CanResult = { ...allow, allowed: false };
const loading: CanResult = { ...allow, isLoading: true };
const error: CanResult = { ...allow, isError: true };

describe('merged Repo permission boundary', () => {
  test('repo-only callers cannot open Review, including a direct review route', () => {
    expect(repoPageSection('repo', allow, allow, deny)).toBe('repo');
    expect(repoPageSection('review', allow, allow, deny)).toBe('denied');
  });

  test('Review requires both READ and ACT', () => {
    expect(repoPageSection('review', deny, allow, allow)).toBe('review');
    expect(repoPageSection('review', deny, deny, allow)).toBe('denied');
    expect(repoPageSection('review', deny, allow, deny)).toBe('denied');
  });

  test('review-only callers fall back from repo; neither permission denies', () => {
    expect(repoPageSection('repo', deny, allow, allow)).toBe('review');
    expect(repoPageSection('repo', deny, deny, deny)).toBe('denied');
  });

  test('loading and failed probes never open protected bodies, even with stale allows', () => {
    expect(repoPageSection('repo', loading, allow, allow)).toBe('loading');
    expect(repoPageSection('repo', error, allow, allow)).toBe('error');
    for (const pending of [loading, error]) {
      expect(repoPageSection('review', allow, pending, allow)).toBe(pending.isError ? 'error' : 'loading');
      expect(repoPageSection('review', allow, allow, pending)).toBe(pending.isError ? 'error' : 'loading');
      expect(repoPageSection('repo', deny, allow, pending)).toBe(pending.isError ? 'error' : 'loading');
    }
  });

  test('a denial counts only once its probe settles (receivedDenial rule)', () => {
    // The trunk gate's settled-only rule: a probe in flight or a failed probe
    // is never a denial. It holds the page or reports the failure — it must
    // not fall back to the review section while its own answer is unknown.
    expect(repoPageSection('repo', { ...deny, isLoading: true }, allow, allow)).toBe('loading');
    expect(repoPageSection('repo', { ...deny, isError: true }, allow, allow)).toBe('error');
  });

  test('tabs list only authorized sections and preserve route and active selection', () => {
    const tabs = (repoOpen: boolean, reviewOpen: boolean) => repoPageTabs({
      projectId: 'p1', section: 'review', repoOpen, reviewOpen,
      repoLabel: 'Repo', reviewLabel: 'Review',
    });
    expect(tabs(true, false).map((tab) => tab.key)).toEqual(['repo']);
    expect(tabs(false, false)).toEqual([]);
    expect(tabs(false, true)).toEqual([
      { key: 'review', label: 'Review', href: '/projects/p1/files/review', active: true },
    ]);
    expect(tabs(true, true).map((tab) => [tab.href, tab.active])).toEqual([
      ['/projects/p1/files', false], ['/projects/p1/files/review', true],
    ]);
  });
});
