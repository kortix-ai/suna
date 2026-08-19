# Default Model Resolution

> Status: **superseded on 2026-07-24**
>
> Current specification:
> [Managed Model Entitlement and Concrete Defaults](2026-07-24-managed-model-entitlement-and-concrete-defaults.md)

The original design used a synthetic `auto` model as a server-side default-model
indirection. Kortix no longer exposes or resolves that model.

Current behavior:

1. Every client sends a concrete model ID.
2. The platform fallback is `glm-5.2`.
3. Account, project, and agent defaults remain concrete model IDs.
4. Default fallback and vision policies match the resolved concrete default.
5. `auto` and `kortix/auto` are stale inputs. The gateway returns
   `400 model_not_found`.
6. Free and `none` tiers cannot use Kortix-managed models.
7. Wallet balance does not grant managed-model entitlement.
8. BYOK and connected ChatGPT/Codex use provider-funded paths.

The former `auto` design is retained in Git history. It is not a supported
runtime or API contract.
