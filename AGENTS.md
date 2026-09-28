# Kortix repository instructions

Read the nearest `AGENTS.md` for directory-specific rules. Each `CLAUDE.md` is a symlink to its sibling `AGENTS.md`; edit only `AGENTS.md`.

## Ownership and safety

Own the problem through implementation, verification, review, and delivery. Start with the observed problem, check failure and edge cases, then prove the result with real inputs. Report what remains unverified. Write precise, short, evidence-backed statements.

Never publish customer data or PII in code, fixtures, commits, PRs, issues, documents, screenshots, videos, or logs. This includes customer names, people's names and emails, real production identifiers, prompts, files, and customer URLs. Use synthetic data and placeholders such as `<session_id>`. Keep sensitive evidence local in gitignored `output/`; never bypass the commit and push guards in `.githooks/`.
If you find customer data in the tree or a PR, remove it on the same branch and report the affected commit. Do not rewrite `main` history.

## Workflow

- Load the applicable skills from `.agents/skills/`; `.claude/skills/` links to them. Always use `worktree` for non-trivial changes, `testing` for behavior, and `contributing` for PRs. The `ponytail` skill is on at level `full`; use `ponytail-review` on the diff before a PR. `learnings` owns incident and near-miss records. For schema changes load `migration`; for `packages/sdk` load `sdk`.
- Join an existing canonical branch for this objective, or create one worktree with `pnpm worktree create --name <slug> --from origin/main --yes --no-start`. Use `pnpm worktree start <slug>` for the full local stack when Docker works. The primary checkout is for investigation, not feature work.
- Open a draft PR against `main` with the `preview` label. Follow `.agents/skills/contributing/SKILL.md` and its references for the PR template, CI, preview, and evidence. Do not treat a local test as deployed verification. Follow the review and merge policy of the task that started you; a factory worker never merges.
- Use `pnpm test` as the repository test runner. Start with the narrowest affected test, then run `pnpm test` before merging. Run touched-package typechecks and lint, and use the preview's `--target-full` report for full-stack verification. Read `tests/README.md` before changing the runner. Verify API changes through HTTP and read-back, CLI changes through the real process, and UI changes with `agent-browser` (load its guide with `agent-browser skills get core`): assert the visible result and relevant network request. No new `docs/` tree: put runbooks in the owning skill's `references/` and incidents in `learnings`.
- `.env` files are dotenvx-encrypted. Use the `dotenvx-secrets` skill for changes; never write plaintext credentials into tracked files or output.

## Runtime architecture

`@kortix/sdk` owns backend data, auth-token plumbing, session lifecycle, transport, and streaming. Web and mobile hosts consume it through `createKortix` and its public APIs. Keep web data-module re-exports thin. Do not add a second host-side client, raw backend `fetch`, or parallel session transport. Load the `sdk` skill before any `packages/sdk` edit; exported names are public contracts. SDK documentation lives in `packages/sdk/README.md` and `apps/web/content/docs/sdk/`.

`main` deploys to dev; `staging` is the release candidate and `prod` is production. Follow `kortix-release` before promotion. Do not treat a healthy endpoint alone as proof of the deployed commit.

## Canonical product design references

| Surface                | Read before changing UI                                                                                                                     | Implemented source                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Web (`apps/web`)       | `.agents/skills/kortix-brand-guidelines/SKILL.md` for values and motion, then `.agents/skills/kortix-design-system/SKILL.md` for components | `apps/web/src/app/globals.css` tokens, `apps/web/src/components/ui/`, live `/design-system`                                   |
| Desktop (Electron)     | The web references above for shared product UI; `apps/desktop-electron/README.md` for native shell boundaries                               | Desktop renders `apps/web`; native window geometry belongs in the shell's titlebar classes, not generic roles or page content |
| Mobile (`apps/mobile`) | `apps/mobile/design.md` for screen design and `apps/mobile/AGENTS.md` for primitives                                                        | `apps/mobile/global.css` colors and `apps/mobile/components/ui/`; mobile keeps stock Tailwind spacing for touch targets       |

The artifact-oriented `brand-guidelines` skill does not replace the product UI references. For shared web/desktop changes, check both surfaces, light/dark themes, 720 × 480 desktop size, zoom, keyboard focus, and scrolling. Run the web brand audit on changed visual files. Mobile design follows its own spacing and native behavior, not web's spacing scale.
