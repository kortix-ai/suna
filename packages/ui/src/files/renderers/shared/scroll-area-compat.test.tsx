import { describe, expect, test } from 'bun:test';

import { mergeRefs } from './scroll-area-compat';

describe('mergeRefs', () => {
  test('assigns the node to object refs and calls function refs', () => {
    const objectRef = { current: null as HTMLDivElement | null };
    const received: Array<HTMLDivElement | null> = [];
    const node = { id: 'viewport' } as unknown as HTMLDivElement;

    mergeRefs<HTMLDivElement>(objectRef, (n) => {
      received.push(n);
    })(node);

    expect(objectRef.current).toBe(node);
    expect(received).toEqual([node]);
  });

  test('skips null and undefined refs', () => {
    const objectRef = { current: null as HTMLDivElement | null };
    const node = {} as HTMLDivElement;

    expect(() => mergeRefs<HTMLDivElement>(null, undefined, objectRef)(node)).not.toThrow();
    expect(objectRef.current).toBe(node);
  });

  test('propagates null on detach to every ref', () => {
    const objectRef = { current: {} as HTMLDivElement | null };
    let functionRefValue: HTMLDivElement | null = {} as HTMLDivElement;

    mergeRefs<HTMLDivElement>(objectRef, (n) => {
      functionRefValue = n;
    })(null);

    expect(objectRef.current).toBeNull();
    expect(functionRefValue).toBeNull();
  });
});
