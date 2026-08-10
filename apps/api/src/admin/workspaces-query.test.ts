import { describe, expect, test } from "bun:test";

import {
  WORKSPACE_STATUS_VALUES,
  parseAdminWorkspacesListQuery,
} from "./workspaces-query";

/** Build a `get` accessor over a plain object, matching `c.req.query`. */
function q(params: Record<string, string>) {
  return (key: string) => params[key];
}

const UUID = "11111111-2222-4333-8444-555555555555";

describe("parseAdminWorkspacesListQuery", () => {
  test("defaults: activity sort, desc, page 1, limit 50, no filters", () => {
    expect(parseAdminWorkspacesListQuery(q({}))).toEqual({
      search: "",
      accountId: null,
      invalidAccountId: false,
      statusValues: [],
      sortBy: "activity",
      sortDir: "desc",
      page: 1,
      limit: 50,
      offset: 0,
    });
  });

  test("accepts the three sort columns and rejects anything else", () => {
    expect(
      parseAdminWorkspacesListQuery(q({ sortBy: "activity" })).sortBy,
    ).toBe("activity");
    expect(parseAdminWorkspacesListQuery(q({ sortBy: "created" })).sortBy).toBe(
      "created",
    );
    expect(
      parseAdminWorkspacesListQuery(q({ sortBy: "sessions" })).sortBy,
    ).toBe("sessions");
    expect(parseAdminWorkspacesListQuery(q({ sortBy: "name" })).sortBy).toBe(
      "activity",
    );
    expect(parseAdminWorkspacesListQuery(q({ sortBy: "" })).sortBy).toBe(
      "activity",
    );
  });

  test('sortDir is asc only on the literal "asc"', () => {
    expect(parseAdminWorkspacesListQuery(q({ sortDir: "asc" })).sortDir).toBe(
      "asc",
    );
    expect(parseAdminWorkspacesListQuery(q({ sortDir: "ASC" })).sortDir).toBe(
      "desc",
    );
    expect(
      parseAdminWorkspacesListQuery(q({ sortDir: "descending" })).sortDir,
    ).toBe("desc");
  });

  test("limit is clamped to [1,100] and page to >= 1", () => {
    expect(parseAdminWorkspacesListQuery(q({ limit: "1000" })).limit).toBe(100);
    expect(parseAdminWorkspacesListQuery(q({ limit: "0" })).limit).toBe(1);
    expect(parseAdminWorkspacesListQuery(q({ limit: "abc" })).limit).toBe(50);
    expect(parseAdminWorkspacesListQuery(q({ page: "0" })).page).toBe(1);
    expect(parseAdminWorkspacesListQuery(q({ page: "-3" })).page).toBe(1);
  });

  test("offset is (page - 1) * limit", () => {
    expect(
      parseAdminWorkspacesListQuery(q({ page: "3", limit: "25" })).offset,
    ).toBe(50);
    expect(
      parseAdminWorkspacesListQuery(q({ page: "1", limit: "25" })).offset,
    ).toBe(0);
  });

  test("search is trimmed", () => {
    expect(
      parseAdminWorkspacesListQuery(q({ search: "  acme  " })).search,
    ).toBe("acme");
  });

  // An unknown status would reach Postgres as a project_status enum literal and
  // raise 22P02 ("invalid input value for enum"), turning a typo into a 500. The
  // parser drops unknown values so the filter degrades to "no status filter".
  test("status keeps only real project_status values, deduped", () => {
    expect(
      parseAdminWorkspacesListQuery(q({ status: "active,archived" }))
        .statusValues,
    ).toEqual(["active", "archived"]);
    expect(
      parseAdminWorkspacesListQuery(q({ status: "active, ACTIVE ,bogus" }))
        .statusValues,
    ).toEqual(["active"]);
    expect(
      parseAdminWorkspacesListQuery(q({ status: "deleted" })).statusValues,
    ).toEqual([]);
    expect(WORKSPACE_STATUS_VALUES).toEqual(["active", "archived"]);
  });

  // A non-uuid accountId is also a 22P02 in Postgres. It is flagged rather than
  // dropped: dropping it would silently widen "one account" to "every account".
  test("accountId passes through only when it is a uuid, and flags a bad one", () => {
    const good = parseAdminWorkspacesListQuery(q({ accountId: UUID }));
    expect(good.accountId).toBe(UUID);
    expect(good.invalidAccountId).toBe(false);

    const bad = parseAdminWorkspacesListQuery(q({ accountId: "not-a-uuid" }));
    expect(bad.accountId).toBeNull();
    expect(bad.invalidAccountId).toBe(true);

    const absent = parseAdminWorkspacesListQuery(q({ accountId: "   " }));
    expect(absent.accountId).toBeNull();
    expect(absent.invalidAccountId).toBe(false);
  });

  test("uuid match is case-insensitive", () => {
    expect(
      parseAdminWorkspacesListQuery(q({ accountId: UUID.toUpperCase() }))
        .accountId,
    ).toBe(UUID.toUpperCase());
  });
});
