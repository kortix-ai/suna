import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { reviewCenterGates } from '@/features/workspace/customize/sections/view/review-view';
import { MOCK_ITEMS } from './mock-data';
import { type ReviewActions, ReviewDetail } from './review-detail';

// An open change with no `crId`: the diff and merge-preview queries stay idle.
const change = MOCK_ITEMS.find((item) => item.kind === 'change' && item.status === 'needs_you')!;

function render(canMerge: boolean | undefined): string {
  const actions: ReviewActions = {
    resolve: () => {},
    decideAction: () => {},
    connected: true,
    canMerge,
  };
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <ReviewDetail item={change} actions={actions} onBack={() => {}} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const allow = (allowed: boolean) => ({ allowed });

// KRTX-1720: "Ship it" on a change request merges it, and the merge route
// asserts project.write + project.gitops.merge. A custom role with review.act
// but without gitops.merge was shown "Ship it", and the merge answered 403.
describe('the Ship it (merge) action on a change request', () => {
  test('a role without the merge leaf gets no Ship it, and keeps Ask for changes', () => {
    const markup = render(false);
    expect(markup).not.toContain('Ship it');
    expect(markup).toContain('Ask for changes');
  });

  test('a role with the merge leaf gets Ship it', () => {
    expect(render(true)).toContain('Ship it');
  });

  test('the prototype inbox, which passes no verdict, keeps Ship it', () => {
    expect(render(undefined)).toContain('Ship it');
  });
});

describe('reviewCenterGates', () => {
  const { PROJECT_REVIEW_ACT: ACT, PROJECT_WRITE: WRITE, PROJECT_GITOPS_MERGE: MERGE } =
    PROJECT_ACTIONS;

  test('a built-in member (review.read + review.submit) acts on nothing and merges nothing', () => {
    expect(reviewCenterGates({})).toEqual({ canAct: false, canMerge: false });
  });

  test('a manager acts and merges', () => {
    expect(
      reviewCenterGates({ [ACT]: allow(true), [WRITE]: allow(true), [MERGE]: allow(true) }),
    ).toEqual({ canAct: true, canMerge: true });
  });

  test('a custom role with review.act but no gitops.merge acts and does not merge', () => {
    expect(reviewCenterGates({ [ACT]: allow(true), [WRITE]: allow(true) })).toEqual({
      canAct: true,
      canMerge: false,
    });
  });

  test('merge needs project.write as well: the route loads the project for write first', () => {
    expect(reviewCenterGates({ [ACT]: allow(true), [MERGE]: allow(true) })).toEqual({
      canAct: true,
      canMerge: false,
    });
  });
});
