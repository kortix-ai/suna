# Kortix V0 Web

This directory is the boundary for the new Kortix web console.

We are intentionally not copying the full legacy `apps/web` app yet. The legacy app is tied to the old instance/VPS model and is roughly a gigabyte with generated build output in the tree. For v0, the web surface stays small while the product spine is still changing.

Current web implementation:

- served by `src/ui.ts`
- single console at `http://127.0.0.1:4310`
- project selector
- repo import/create
- files
- agents/skills
- declared env + vault status
- sessions/live chat

Target extraction:

```txt
apps/kortix-v0/
  src/        API and runtime orchestration
  web/        new web console
  schemas/    public project schemas
```

Once the flow stops moving every hour, move `src/ui.ts` into a real frontend under this directory and selectively copy components/styles from legacy `apps/web`.
