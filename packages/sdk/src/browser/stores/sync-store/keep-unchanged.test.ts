import { expect, test } from "bun:test";
import { keepUnchanged, sameValue } from "./keep-unchanged";

test("sameValue compares content, not key order or identity", () => {
	expect(sameValue({ a: 1, b: { c: [1, "x"] } }, { b: { c: [1, "x"] }, a: 1 })).toBe(true);
	expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
	expect(sameValue([1, 2], [2, 1])).toBe(false);
	expect(sameValue({ a: [1] }, { a: { 0: 1 } })).toBe(false);
	expect(sameValue(null, {})).toBe(false);
});

test("keepUnchanged returns the previous list when every message is unchanged", () => {
	const previous = [{ id: "m1", v: 1 }];
	const previousParts = { m1: [{ id: "p1", text: "a" }] };
	const nextParts = { m1: [{ id: "p1", text: "a" }] };
	expect(keepUnchanged(previous, [{ id: "m1", v: 1 }], previousParts, nextParts)).toBe(previous);
	expect(nextParts.m1).toBe(previousParts.m1);
});

test("keepUnchanged keeps a new list when a message was added", () => {
	const previous = [{ id: "m1", v: 1 }];
	const kept = keepUnchanged(previous, [{ id: "m1", v: 1 }, { id: "m2", v: 1 }], {}, {});
	expect(kept).not.toBe(previous);
	expect(kept[0]).toBe(previous[0]);
});
