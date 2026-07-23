import { beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@opencode-ai/sdk/v2/client";
import { useSyncStore } from "../stores/sync-store";
import {
  getSessionSyncController,
  prefetchSessionSyncWithClient,
  readSessionMessagePage,
  resetSessionSyncControllers,
  retainSessionSyncController,
} from "./session-sync-registry";

beforeEach(() => {
  resetSessionSyncControllers();
  useSyncStore.getState().reset();
});

describe("readSessionMessagePage", () => {
	test("preserves MessageWithParts and reads the legacy older-page cursor", async () => {
		const requests: unknown[] = [];
		const client = {
			session: {
				messages: async (request: unknown) => {
					requests.push(request);
					return {
						data: [
							{
								info: {
									id: "message-1",
									sessionID: "session-1",
									role: "user",
								} as Message,
								parts: [],
							},
						],
						response: new Response(null, {
							headers: { "X-Next-Cursor": "message-older" },
						}),
					};
				},
			},
		};

		const result = await readSessionMessagePage(
			client,
			"session-1",
			{ limit: 10, before: "message-newer",
    });

		expect(requests).toEqual([
			{
				sessionID: "session-1",
				limit: 10,
				before: "message-newer",
			},
		]);
		expect(result.messages[0]?.info.id).toBe("message-1");
		expect(result.nextCursor).toBe("message-older");
	});
});

describe("prefetchSessionSyncWithClient", () => {
  test("hydrates one bounded tail per explicit revalidation", async () => {
    const requests: unknown[] = [];
    const client = {
      session: {
        messages: async (request: unknown) => {
          requests.push(request);
          return {
            data: [
              {
                info: {
                  id: "message-1",
                  sessionID: "session-1",
                  role: "user",
                } as Message,
                parts: [],
              },
            ],
          };
        },
      },
    };

    expect(await prefetchSessionSyncWithClient("session-1", client)).toBe(true);
    expect(await prefetchSessionSyncWithClient("session-1", client)).toBe(true);

    expect(requests).toEqual([
      { sessionID: "session-1", limit: 10 },
      { sessionID: "session-1", limit: 10 },
    ]);
    expect(useSyncStore.getState().messages["session-1"]?.[0]?.id).toBe(
      "message-1",
    );
  });

  test("rebinds a prefetched controller when the session runtime changes", async () => {
    const requests: string[] = [];
    const client = (runtime: string) => ({
      session: {
        messages: async () => {
          requests.push(runtime);
          return {
            data: [
              {
                info: {
                  id: `message-${runtime}`,
                  sessionID: "session-1",
                  role: "user",
                } as Message,
                parts: [],
              },
            ],
          };
        },
      },
    });

    await prefetchSessionSyncWithClient("session-1", client("runtime-a"));
    const controller = getSessionSyncController(
      "session-1",
      client("runtime-b"),
    );
    await controller.reconcile("manual");

    expect(requests).toEqual(["runtime-a", "runtime-b"]);
  });
});

describe("session sync controller eviction", () => {
  test("keeps every retained controller and evicts released overflow", () => {
    const retained: Array<{
      controller: ReturnType<typeof getSessionSyncController>;
      release: () => void;
    }> = [];

    for (let index = 0; index < 21; index += 1) {
      const sessionId = `session-${index}`;
      const controller = getSessionSyncController(sessionId);
      retained.push({
        controller,
        release: retainSessionSyncController(sessionId),
      });
      expect(getSessionSyncController(sessionId)).toBe(controller);
    }

    retained[0]?.release();
    expect(getSessionSyncController("session-0")).not.toBe(
      retained[0]?.controller,
    );
    for (const entry of retained.slice(1)) entry.release();
  });
});
