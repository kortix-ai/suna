import { describe, test, expect } from "bun:test";
import {
  CREDITS_PER_DOLLAR,
  dollarsToCredits,
  creditsToDollars,
  formatUsdAsCredits,
  formatCredits,
  formatCreditsWithSign,
  formatDollarsAsCredits,
  parseBalanceUsd,
} from "./credit-formatter";

describe("dollarsToCredits / creditsToDollars", () => {
  test("converts dollars to credits and back", () => {
    expect(dollarsToCredits(1)).toBe(CREDITS_PER_DOLLAR);
    expect(dollarsToCredits(2.5)).toBe(250);
    expect(creditsToDollars(100)).toBe(1);
    expect(creditsToDollars(250)).toBe(2.5);
  });

  test("rounds fractional credits when converting from dollars", () => {
    expect(dollarsToCredits(0.005)).toBe(1); // 0.5 credits -> rounds to 1
    expect(dollarsToCredits(0.004)).toBe(0); // 0.4 credits -> rounds to 0
  });
});

describe("formatCredits", () => {
  test("uses the requested locale for grouping", () => {
    expect(formatCredits(1234567, { locale: "de-DE" })).toBe("1.234.567");
  });

  test("formats integers with thousand separators", () => {
    expect(formatCredits(1000)).toBe("1,000");
    expect(formatCredits(1234567)).toBe("1,234,567");
    expect(formatCredits(0)).toBe("0");
  });

  test("handles null / undefined / NaN", () => {
    expect(formatCredits(null)).toBe("0");
    expect(formatCredits(undefined)).toBe("0");
    expect(formatCredits(NaN)).toBe("0");
  });

  test("never renders negative zero for tiny negatives", () => {
    // Math.round(-0.4) === -0, which used to stringify as "-0".
    expect(formatCredits(-0.4)).toBe("0");
    expect(formatCredits(-0.49)).toBe("0");
    expect(formatCredits(-0)).toBe("0");
  });

  test("rounds to nearest integer by default", () => {
    expect(formatCredits(12.4)).toBe("12");
    expect(formatCredits(12.5)).toBe("13");
    expect(formatCredits(-12.4)).toBe("-12");
  });

  test("shows two decimals when requested", () => {
    expect(formatCredits(1234.5, { showDecimals: true })).toBe("1,234.50");
    expect(formatCredits(0, { showDecimals: true })).toBe("0.00");
  });
});

describe("formatCreditsWithSign", () => {
  test("prefixes a sign based on value", () => {
    expect(formatCreditsWithSign(100)).toBe("+100");
    expect(formatCreditsWithSign(-100)).toBe("-100");
    expect(formatCreditsWithSign(0)).toBe("+0");
  });

  test("handles null / undefined / NaN", () => {
    expect(formatCreditsWithSign(null)).toBe("0");
    expect(formatCreditsWithSign(undefined)).toBe("0");
    expect(formatCreditsWithSign(NaN)).toBe("0");
  });

  test('tiny negatives that round to zero read as "+0", never "-0"', () => {
    expect(formatCreditsWithSign(-0.4)).toBe("+0");
    expect(formatCreditsWithSign(-0.49)).toBe("+0");
    expect(formatCreditsWithSign(-0)).toBe("+0");
  });

  test("keeps the sign for amounts that round to a nonzero magnitude", () => {
    expect(formatCreditsWithSign(-0.5)).toBe("-1");
    expect(formatCreditsWithSign(-12.4)).toBe("-12");
    expect(formatCreditsWithSign(12.4)).toBe("+12");
  });
});

describe("formatDollarsAsCredits", () => {
  test("converts dollars to a formatted credit string", () => {
    expect(formatDollarsAsCredits(1)).toBe("100");
    expect(formatDollarsAsCredits(12.34)).toBe("1,234");
  });
});

describe('formatUsdAsCredits: a USD amount the account holds or spent, shown in credits', () => {
  test('whole credits from 10 up, grouped', () => {
    expect(formatUsdAsCredits(868.15)).toBe('86,815');
    expect(formatUsdAsCredits(0.1)).toBe('10');
    expect(formatUsdAsCredits(5000)).toBe('500,000');
  });

  test('below 10 credits keeps up to two decimals, so a turn never reads 0', () => {
    expect(formatUsdAsCredits(0.0034)).toBe('0.34');
    expect(formatUsdAsCredits(0.035)).toBe('3.5');
    expect(formatUsdAsCredits(0.01)).toBe('1');
  });

  test('a non-zero amount below 0.01 credits reads <0.01; zero reads 0', () => {
    expect(formatUsdAsCredits(0.00004)).toBe('<0.01');
    expect(formatUsdAsCredits(0)).toBe('0');
    expect(formatUsdAsCredits(null)).toBe('0');
  });

  test('negative balances keep their sign', () => {
    expect(formatUsdAsCredits(-12.5)).toBe('-1,250');
    expect(formatUsdAsCredits(-0.0034)).toBe('-0.34');
  });

  test('the locale groups and separates', () => {
    expect(formatUsdAsCredits(868.15, { locale: 'de' })).toBe('86.815');
    expect(formatUsdAsCredits(0.0034, { locale: 'de' })).toBe('0,34');
  });
});

describe("parseBalanceUsd: the balance a 402 message names, in USD", () => {
  test("reads the credits message the API sends", () => {
    expect(parseBalanceUsd("Insufficient credits. Balance: 1,250 credits, required: 3 credits")).toBe(12.5);
    expect(parseBalanceUsd("Payment Required: Insufficient credits. Balance: -6 credits")).toBe(-0.06);
    expect(parseBalanceUsd("Balance: 0.34 credits")).toBeCloseTo(0.0034, 10);
    expect(formatUsdAsCredits(parseBalanceUsd("Balance: <0.01 credits"))).toBe("<0.01");
    expect(formatUsdAsCredits(parseBalanceUsd("Balance: -<0.01 credits"))).toBe("-<0.01");
  });

  test("reads the dollar message older servers send", () => {
    expect(parseBalanceUsd("Insufficient credits. Balance: $1.0000, required: $5.0000")).toBe(1);
    expect(parseBalanceUsd("Payment Required: Insufficient credits. Balance: $-0.06")).toBe(-0.06);
    expect(parseBalanceUsd("balance: 12.5 remaining")).toBe(12.5);
  });

  test("a message without a balance reads null", () => {
    expect(parseBalanceUsd("Payment Required")).toBeNull();
  });
});
