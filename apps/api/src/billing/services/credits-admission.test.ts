import { beforeEach, expect, mock, test } from "bun:test";

let calls: Array<{ name: string; args: Record<string, unknown> }> = [];
mock.module("../../shared/supabase", () => ({
  getSupabase: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return {
        data: { success: true, amount_deducted: 0.01, new_total: 1.99 },
        error: null,
      };
    },
  }),
}));
mock.module("./auto-topup", () => ({
  checkAndTriggerAutoTopup: async () => undefined,
}));
const { deductCredits } = await import("./credits");
beforeEach(() => {
  calls = [];
});

test.each([undefined, "", "admission:one"])(
  "admission selects the idempotency-aware RPC overload with key %s",
  async (key) => {
    const result = await deductCredits(
      "account",
      0.01,
      "Admission",
      "llm_debit",
      key,
    );
    expect(result.newBalance).toBe(1.99);
    expect(calls).toEqual([
      {
        name: "atomic_use_credits",
        args: {
          p_account_id: "account",
          p_amount: 0.01,
          p_description: "Admission",
          p_ledger_type: "llm_debit",
          p_idempotency_key: key || null,
        },
      },
    ]);
  },
);
