// KRTX-1734: the Sessions page's bulk delete keeps every session restorable
// for 30 days and keeps its branch. Its confirm says so, in the same words as
// the single-session delete.
import { describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The real dialog is a Radix portal; the subject here is what this dialog hands it.
const uiConfirmDialogMock = () => ({
  ConfirmDialog: (props: { open: boolean; title: ReactNode; description: ReactNode; confirmLabel: string }) =>
    props.open ? (
      <div>
        <h2>{props.title}</h2>
        <p>{props.description}</p>
        <button type="button">{props.confirmLabel}</button>
      </div>
    ) : null,
});
mock.module('../../primitives/confirm-dialog', uiConfirmDialogMock);
mock.module('../../primitives/confirm-dialog', uiConfirmDialogMock);

const { SessionsBulkDeleteDialog } = await import('./sessions-bulk-delete-dialog');

describe('SessionsBulkDeleteDialog', () => {
  test('says each session can be restored for 30 days and that its branch is kept', () => {
    const html = renderToStaticMarkup(
      <SessionsBulkDeleteDialog count={5} open isPending={false} onOpenChange={() => {}} onConfirm={() => {}} />,
    );
    expect(html).toContain('<h2>Delete 5 sessions?</h2>');
    expect(html).toContain(
      '<p>Deletes each selected session and removes its sandbox. You can restore each one from Recently deleted for 30 days. After that, its messages and files are deleted. Its branch is kept.</p>',
    );
    expect(html).not.toContain('cannot be undone');
    expect(html).toContain('>Delete 5</button>');
  });
});
