import { describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const request = {
  requestId: 'request-test-dialog',
  tunnelId: 'tunnel-test',
  capability: 'unknown',
  requestedScope: {},
};
const removed: string[] = [];
let onOpenChange: ((open: boolean) => void) | undefined;

mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => {
    const translate = (key: string) => key;
    translate.raw = (key: string) => key;
    return translate;
  },
}));

mock.module('@/stores/tunnel-store', () => ({
  useTunnelStore: (selector: (state: unknown) => unknown) =>
    selector({
      pendingRequests: [request],
      removePendingRequest: (requestId: string) => removed.push(requestId),
    }),
}));

mock.module('@/hooks/tunnel/use-tunnel', () => ({
  useApprovePermissionRequest: () => ({ isPending: true, mutateAsync: async () => {} }),
  useDenyPermissionRequest: () => ({ isPending: false, mutateAsync: async () => {} }),
}));

const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({
    children,
    onOpenChange: handler,
  }: {
    children?: ReactNode;
    onOpenChange: typeof onOpenChange;
  }) => {
    onOpenChange = handler;
    return <div>{children}</div>;
  },
  DialogContent: passthrough,
  DialogDescription: passthrough,
  DialogFooter: passthrough,
  DialogHeader: passthrough,
  DialogTitle: passthrough,
}));
mock.module('@/components/ui/select', () => ({
  Select: passthrough,
  SelectContent: passthrough,
  SelectItem: passthrough,
  SelectTrigger: passthrough,
  SelectValue: passthrough,
}));

const { TunnelPermissionRequestDialog } = await import('./tunnel-permission-request-dialog');

describe('TunnelPermissionRequestDialog', () => {
  test('Escape or the close button dismisses the request while a mutation is pending', () => {
    removed.length = 0;
    onOpenChange = undefined;

    renderToStaticMarkup(<TunnelPermissionRequestDialog />);
    expect(onOpenChange).toBeFunction();

    const closeDialog = onOpenChange as unknown as (open: boolean) => void;
    closeDialog(false);
    expect(removed).toEqual([request.requestId]);
  });
});
