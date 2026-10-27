import { describe, expect, mock, test } from "bun:test";

import type { QueryClient } from "@tanstack/react-query";

import { prefetchArtifact, seedSavedText } from "./use-artifacts";
import { qk } from "./query-keys";

function client(detail: unknown) {
  const fetchQuery = mock(async () => detail);
  const prefetchQuery = mock(async () => undefined);
  return { queryClient: { fetchQuery, prefetchQuery } as unknown as QueryClient, fetchQuery, prefetchQuery };
}

describe("prefetchArtifact", () => {
  test("a doc: warms the detail, then its Markdown under the entry version, so opening it needs no request", async () => {
    const { queryClient, fetchQuery, prefetchQuery } = client({ type: "doc", entry_version: "v7", version: { id: null } });

    await prefetchArtifact(queryClient, "p1", "a1");

    expect((fetchQuery.mock.calls[0] as unknown as [{ queryKey: unknown }])[0].queryKey).toEqual(qk.project.artifact("p1", "a1"));
    expect(prefetchQuery).toHaveBeenCalledTimes(1);
    const text = (prefetchQuery.mock.calls[0] as unknown as [{ queryKey: unknown; staleTime: number }])[0];
    expect(text.queryKey).toEqual(qk.project.artifactText("p1", "a1", "v7"));
    expect(text.staleTime).toBe(Infinity);
  });

  test("a page: warms only the detail (its frame comes from the frame pool)", async () => {
    const { queryClient, prefetchQuery } = client({ type: "html", entry_version: "v1", version: { id: null } });

    await prefetchArtifact(queryClient, "p1", "a1");

    expect(prefetchQuery).not.toHaveBeenCalled();
  });
});

describe("seedSavedText", () => {
  test("a doc save puts the saved Markdown under the new entry version, so reopening it needs no request", () => {
    const setQueryData = mock(() => undefined);
    const queryClient = { setQueryData } as unknown as QueryClient;

    seedSavedText(queryClient, "p1", { artifact_id: "a1", type: "doc", entry: "notes.md", entry_version: "v8" }, { files: { "notes.md": { content: "# Hi\n" } } });

    expect(setQueryData).toHaveBeenCalledWith(qk.project.artifactText("p1", "a1", "v8"), "# Hi\n");
  });

  test("a save that does not write the entry (a media upload) seeds nothing", () => {
    const setQueryData = mock(() => undefined);
    const queryClient = { setQueryData } as unknown as QueryClient;

    seedSavedText(queryClient, "p1", { artifact_id: "a1", type: "doc", entry: "index.md", entry_version: "v8" }, { files: { "media/x.png": { content_base64: "AA==" } } });

    expect(setQueryData).not.toHaveBeenCalled();
  });
});
