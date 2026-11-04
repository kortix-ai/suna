---
recorded: 2026-10-26T16:53:26Z
incident_date: 2026-10-26
---
# Never reuse an object after Bun's toMatchObject with an asymmetric matcher: Bun 1.4.3 writes the matcher into the received object

**Rule:** After `expect(x).toMatchObject({ k: expect.any(...) })` (or `expect.stringMatching`, `expect.objectContaining`), do not assert on `x.k` again and do not compare `x` with `toEqual`. Read the values you need into plain variables first, or assert plain values: `expect([x.a, x.b > 0]).toEqual([1, true])`.

**Trigger surface:** Writing a `bun:test` assertion that mixes `toMatchObject` and an asymmetric matcher with a later check of the same object, often on a spied logger call (`warn.mock.calls[0][1]`).

**Incident:** 2026-10-26, near-miss while writing the merge-subset tests. `expect(meta).toMatchObject({ bytes: expect.any(Number) })` passed, then `meta.bytes` was `{}` (`JSON.stringify` showed `"bytes":{}`). A later `toEqual` against an object that went through the same call passes for that key whatever its value. Reproduced on Bun 1.4.3: `const o = { a: 5 }; expect(o).toMatchObject({ a: expect.any(Number) });` leaves `typeof o.a === 'object'`.

**Enforcement:** none yet: a lint rule that flags an asymmetric matcher inside `toMatchObject` on a variable that a later assertion reads, or a Bun upgrade with the fix and a regression test.
