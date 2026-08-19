import { describe, expect, mock, test } from "bun:test";

import type { QueryClient } from "@tanstack/react-query";

import { sessionStartKey } from "../core/rest/projects-client";
import { prefetchSessionStart } from "./prefetch-session-start";

describe("prefetchSessionStart", () => {
  test("returns the underlying prefetch promise so callers can sequence on /start settling", async () => {
    // apps/web defers its sessions-list invalidate until this settles: the
    // list refetch must not race the warm-marker drop `/start` performs
    // (use-new-project-session.ts). A void return forced hosts to guess.
    const sentinel = Promise.resolve();
    const prefetchQuery = mock(() => sentinel);
    const queryClient = { prefetchQuery } as unknown as QueryClient;

    const result = prefetchSessionStart(queryClient, "p1", "s1");

    expect(result).toBe(sentinel);
    expect(prefetchQuery).toHaveBeenCalledTimes(1);
    const args = prefetchQuery.mock.calls[0] as unknown as [
      { queryKey: unknown; staleTime: number },
    ];
    expect(args[0].queryKey).toEqual(sessionStartKey("p1", "s1"));
    expect(args[0].staleTime).toBe(0);
  });
});
