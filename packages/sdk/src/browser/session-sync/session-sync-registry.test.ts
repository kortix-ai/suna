import { describe, expect, test } from "bun:test";
import type { Message } from "@opencode-ai/sdk/v2/client";
import { readSessionMessagePage } from "./session-sync-registry";

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
			{ limit: 10, before: "message-newer" },
		);

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
