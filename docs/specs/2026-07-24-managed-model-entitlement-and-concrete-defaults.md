# Managed Model Entitlement and Concrete Defaults

Status: approved for implementation
Date: 2026-07-24

## Problem

`accountIsFreeTierForModels()` exempts `dev` and `preview`.

That exemption lets a free-tier account use Kortix-managed LLM credentials.
The account wallet can then receive LLM debits.

The synthetic `auto` model hides the selected upstream model.
The SDK sends `kortix/auto` when a user does not select a model.
The gateway resolves that value to a provider-funded or Kortix-managed model.

## Required invariants

1. Tier controls Kortix-managed model entitlement.
2. `free`, `none`, and unknown tiers cannot use Kortix-managed models.
3. The rule applies in `dev`, `preview`, `staging`, and `prod`.
4. Wallet balance does not grant Kortix-managed model entitlement.
5. Free-tier wallet credits fund sandbox compute only.
6. Paid tiers retain Kortix-managed model access.
7. BYOK models use the project owner's provider credentials.
8. Codex models use the connected ChatGPT account.
9. BYOK and Codex remain available to free-tier accounts.
10. No catalog, picker, runtime default, SDK send, CLI output, or UI control exposes `auto`.
11. Stale `auto` and `kortix/auto` requests return a typed `400` client error.
12. Default-model responses return a concrete model ID.

## Default model behavior

The control plane owns one concrete platform default.

The SDK sends the resolved concrete model.
The sandbox runtime uses the concrete platform default when no project value exists.
Project routing policies still apply to concrete model IDs.

`auto` is not an alias.
`auto` is not a fallback policy ID.
`auto` is not a compatibility route.

## Billing behavior

The LLM gateway does not take a wallet hold for a free-tier account.

Kortix-managed resolution rejects the request before dispatch.
BYOK and Codex candidates use `billingMode: "none"`.
The compute metering path remains unchanged.

## Error contract

A stale `auto` request returns:

```json
{
  "code": "model_not_found",
  "message": "\"auto\" is not a recognized model."
}
```

The gateway must not convert this request into `502 routing_unavailable`.

## Verification

- Test entitlement in every environment.
- Test positive-wallet authorization without an LLM wallet hold.
- Test managed model rejection for free and unknown tiers.
- Test managed model success for paid tiers.
- Test BYOK and Codex success for free tiers.
- Test catalog and picker responses without `auto`.
- Test SDK sends without `kortix/auto`.
- Test runtime defaults without `kortix/auto`.
- Run local HTTP requests for free and paid accounts.
- Repeat the requests against the deployed dev gateway.
