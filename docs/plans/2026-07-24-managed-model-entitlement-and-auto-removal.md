# Managed Model Entitlement and Auto Removal Plan

1. Replace environment-dependent entitlement tests.
2. Add regression tests for wallet-independent entitlement.
3. Add catalog, SDK, runtime, and stale-request tests.
4. Run the tests and record the expected failures.
5. Make `accountIsFreeTierForModels()` environment-independent.
6. Add an LLM billing gate that never holds free-tier wallet credits.
7. Remove the synthetic model from `@kortix/llm-catalog`.
8. Remove synthetic model handling from gateway routing and resolution.
9. Make API default-model responses concrete.
10. Make the SDK send concrete model keys.
11. Remove the UI toggle and catalog special cases.
12. Replace the sandbox runtime default with a concrete model.
13. Remove CLI references to synthetic routing.
14. Run focused tests and all SDK release gates.
15. Verify free-tier and paid-tier requests against the local API.
16. Push the branch and open a pull request.
17. Merge the pull request after required checks pass.
18. Verify the merged SHA in Deploy Dev.
19. Repeat the free-tier and paid-tier requests against dev.
