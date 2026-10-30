import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createElement, useEffect, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useAddRequest } from './use-add-request';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

function List({ addRequest, onOpen, onHandled }: { addRequest: number; onOpen: () => void; onHandled: () => void }) {
  useAddRequest(addRequest, onOpen, onHandled);
  return null;
}

// The page hands its "request again" action to the test through a callback
// prop, after the render.
function Page({ onOpen, exposeBump }: { onOpen: () => void; exposeBump: (bump: () => void) => void }) {
  const [addRequest, setAddRequest] = useState(1);
  useEffect(() => {
    exposeBump(() => setAddRequest((n) => n + 1));
  }, [exposeBump]);
  return createElement(List, { addRequest, onOpen, onHandled: () => setAddRequest(0) });
}

const errors = spyOn(console, 'error');
afterEach(() => errors.mockClear());

// KRTX-2185: the connector page logged "Cannot update a component
// (`ConnectorPageBody`) while rendering a different component
// (`ConnectionsList`)": the list reset the page's request during its render.
describe('useAddRequest', () => {
  test('opens once per request, and resets the caller after the render', async () => {
    const onOpen = mock(() => undefined);
    let bump: () => void = () => undefined;
    const exposeBump = (fn: () => void) => {
      bump = fn;
    };
    let root: ReactTestRenderer | undefined;
    await act(async () => {
      root = create(createElement(Page, { onOpen, exposeBump }));
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    await act(async () => bump());
    expect(onOpen).toHaveBeenCalledTimes(2);
    const renderPhaseUpdates = errors.mock.calls.filter((call) =>
      String(call[0]).includes('while rendering a different component'),
    );
    expect(renderPhaseUpdates).toEqual([]);
    await act(async () => root?.unmount());
  });

  test('a remount after the reset does not open it again', async () => {
    const onOpen = mock(() => undefined);
    let root: ReactTestRenderer | undefined;
    await act(async () => {
      root = create(createElement(List, { addRequest: 0, onOpen, onHandled: () => undefined }));
    });
    expect(onOpen).not.toHaveBeenCalled();
    await act(async () => root?.unmount());
  });
});
