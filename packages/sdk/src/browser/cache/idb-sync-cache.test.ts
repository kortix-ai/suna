import { describe, expect, test } from "bun:test";
import { selectCacheKeysToPrune } from "./idb-sync-cache-helpers";

describe("selectCacheKeysToPrune", () => {
	test("returns object-store cache keys instead of session ids", () => {
		const entries = [
			{ cacheKey: "user:a:session:new", updatedAt: 30 },
			{ cacheKey: "user:a:session:middle", updatedAt: 20 },
			{ cacheKey: "user:a:session:old", updatedAt: 10 },
		];

		expect(selectCacheKeysToPrune(entries, 2)).toEqual([
			"user:a:session:old",
		]);
	});
});
