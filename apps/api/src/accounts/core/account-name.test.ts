import { describe, expect, test } from "bun:test";

import { profileNameFromMetadata, suggestAccountName } from "./account-name";

describe("suggestAccountName (KRTX-638)", () => {
  test("prefers the first name from the sign-in profile", () => {
    expect(
      suggestAccountName({
        email: "ada@example.com",
        fullName: "ada lovelace",
      }),
    ).toBe("Ada's workspace");
  });

  test("otherwise the email's local part, as is", () => {
    expect(suggestAccountName({ email: "ada42@gmail.com" })).toBe("ada42");
    expect(suggestAccountName({ email: "ada.lovelace@outlook.com" })).toBe(
      "ada.lovelace",
    );
    expect(suggestAccountName({ email: "ada@acme.com" })).toBe("ada");
  });

  test("never the address and never the domain — no account called Gmail", () => {
    for (const email of ["ada42@gmail.com", "ada@acme.com", "7x@gmail.com"]) {
      const name = suggestAccountName({ email });
      expect(name).not.toContain("@");
      expect(name).not.toMatch(/gmail|acme/i);
      expect(name).not.toContain("'s Account");
    }
  });

  test('falls back to "My workspace" when nothing usable is known', () => {
    expect(suggestAccountName({})).toBe("My workspace");
    expect(suggestAccountName({ email: "@gmail.com" })).toBe("My workspace");
  });
});

describe("profileNameFromMetadata", () => {
  test("reads full_name, then name, and ignores blanks and non-strings", () => {
    expect(profileNameFromMetadata({ full_name: " Ada Lovelace " })).toBe(
      "Ada Lovelace",
    );
    expect(profileNameFromMetadata({ name: "Ada" })).toBe("Ada");
    expect(profileNameFromMetadata({ full_name: "  " })).toBeNull();
    expect(profileNameFromMetadata({ full_name: 42 })).toBeNull();
    expect(profileNameFromMetadata(undefined)).toBeNull();
  });
});
