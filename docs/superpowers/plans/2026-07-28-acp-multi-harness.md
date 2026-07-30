# ACP and Multi-Harness Implementation Plan

1. Add one shared harness descriptor.
2. Add `kortix_version: 3` validation and JSON Schema output.
3. Compile v3 runtime profiles into a runtime-neutral launch plan.
4. Resolve the selected logical agent during session creation.
5. Gate non-OpenCode selection with `experimental.acp_runtime`.
6. Persist immutable harness and runtime identity metadata.
7. Emit runtime-neutral sandbox environment fields.
8. Boot the selected harness process in the sandbox daemon.
9. Separate ACP server and protocol session IDs in the SDK.
10. Expose harness metadata in project config and project-session responses.
11. Add harness labels to the web agent selector.
12. Route headless follow-up prompts through ACP.
13. Update starter examples and runtime documentation.
14. Run package, local stack, browser, and four-harness sandbox verification.
15. Open the PR, merge it, deploy `main`, and verify the deployed SHA.
