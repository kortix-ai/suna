import { expect, test } from "bun:test";

import { suggestAccountName } from "./account-name";

test("email-only signups get a neutral workspace name, including tagged addresses", () => {
  for (const local of ["signup", "signup+cleanup", "signup+one+two", ""]) {
    expect(suggestAccountName({ email: `${local}@example.test` })).toBe("My workspace");
  }
});

test("a missing or blank profile does not expose the email local part", () => {
  for (const fullName of [undefined, null, "", " \t "]) {
    expect(suggestAccountName({ email: "signup+cleanup@example.test", fullName })).toBe("My workspace");
  }
});

test("a supplied profile name still takes precedence", () => {
  expect(suggestAccountName({ email: "signup+cleanup@example.test", fullName: " Example Person " })).toBe("Example's workspace");
});
