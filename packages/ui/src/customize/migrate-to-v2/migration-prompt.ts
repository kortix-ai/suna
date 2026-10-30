/**
 * The seed prompt for "Upgrade manifest to v3": a normal agent session does
 * the conversion, because it is files and git. Upgrading starts a fresh
 * session with this as the first message; the project's default agent runs
 * `kortix migrate`, checks what it cannot know, and opens a change request for
 * a human to review. Nothing here merges anything.
 *
 * `kortix migrate` (apps/cli/src/commands/migrate.ts) holds the conversion
 * rules for kortix_version 1 and 2, so this prompt carries only what the tool
 * cannot decide: the marketplace baseline, the checks after the conversion, the
 * old folders, validation and the landing contract.
 *
 * `kortix projects upgrade` (apps/cli/src/commands/projects.ts) sends a
 * verbatim copy. `projects-parity.test.ts` fails when the two differ.
 */
export const MIGRATE_TO_V3_PROMPT = `Upgrade this project's manifest to kortix_version 3 (kortix.yaml). Check \`kortix_version\` at the top of the manifest first: kortix_version 1 is \`kortix.toml\`, 2 and 3 are \`kortix.yaml\`. On kortix_version 3 there is nothing to upgrade: say so and stop. Land the upgrade as a change request — do not merge it yourself.

## 1. Bring the platform baseline up to date first

1. \`kortix marketplace updates\` — a hash-diff report of every marketplace-tracked item (the Kortix-managed skills, plus any marketplace skills the user installed).
2. If updates are listed, apply them: \`kortix marketplace update --all\`. **This commits directly to \`main\` through the platform's own hash-safe update path — it is intentionally NOT part of your change request.**
3. Sync your session branch on top of the refreshed main: \`git fetch origin && git rebase origin/main\`.
4. Items reported as \`orphaned\` (no longer in the catalog) are not updatable — leave them alone and mention them in the change request description.

## 2. Convert with kortix migrate

1. Run \`kortix migrate\`. It prints the plan, the new \`kortix.yaml\`, a "Not carried over" list, and whether the result validates. It changes nothing.
2. Run \`kortix migrate --write\`. It writes the v3 \`kortix.yaml\`, moves each agent's behavior out of its \`.md\` frontmatter into its \`agents.<name>\` block, keeps the prompt in the \`.md\` as its \`prompt_file\`, and deletes \`kortix.toml\` and \`opencode.json(c)\`. It refuses a result that does not validate: fix what it reports, then run it again.
3. Carry over by hand each "Not carried over" item that has a v3 key. \`kortix schema --version 3\` prints the exact schema. List each item that has no v3 key in the change request description; do not invent a key for it.

## 3. Check what kortix migrate cannot decide

- **Grants.** v3 grants are deny-by-default. Every agent must keep the access it has today: \`skills\`, \`subagents\`, \`commands\`, \`extensions\`, \`connectors\`, \`secrets\`, \`kortix_permissions\` and \`workspace: { project_repository: true }\` for an agent that works in the repository. Never widen a grant to cover a key you removed.
- **The default agent.** \`default_agent\` must name a declared agent with \`mode: primary\` or \`all\`. A kortix_version 1 project takes it from \`opencode.jsonc\`, else from its first agent. Confirm the choice and record it and the reason in the change request description.
- **Old folders.** v3 reads no harness folder: \`harnesses/\` and \`.kortix/opencode/\` are not read. Move every file that a registry or a \`prompt_file\` still names there to the root folders (\`agents/\`, \`skills/\`, \`tools/\`, \`commands/\`, \`extensions/\`) with \`git mv\`, and update the path in \`kortix.yaml\`. From kortix_version 1, also run \`git mv .kortix/memory memory\`. Keep \`.kortix/state/\` and \`.kortix/link.json\`. Then delete what is left: \`git rm -r harnesses/\` or \`git rm -r .kortix/opencode/\`.
- **OpenCode-only extensions.** Every new session runs pi, and pi loads only an extension's \`pi:\` implementation. \`kortix migrate\` turns each OpenCode plugin into an extension with only an \`opencode:\` implementation (under \`extensions/opencode/\`), which never loads. Remove each such extension from \`extensions\` and from every agent's \`extensions\` grant, and \`git rm -r\` its files. List each one in the change request description; when it did something the project needs, say that a pi extension (\`pi:\`) replaces it.
- **Old paths.** Run \`git grep -n -e '.kortix/opencode' -e '.kortix/memory' -e 'harnesses/'\` and replace each old path with the new one, in prompts, skills, tools and \`.gitignore\`. Change only the path.

## 4. Validate before you are done

Run \`kortix validate\`. Fix every error it reports. Do not open the change request with a manifest that fails validation.

## 5. Land it as a change request — never merge

First, re-sync: \`git fetch origin\` and check whether \`origin/main\` advanced while you worked (\`git log HEAD..origin/main --oneline\`). If it moved, rebase. If the rebase conflicts on the manifest or a moved file, \`git rebase --abort\`, \`git reset --hard origin/main\`, and redo the conversion against the current files. Never revert main's changes to win a conflict.

Then commit, **push the branch**, and open the change request. A commit that is never pushed leaves the CR empty (\`422 CR_HEAD_NOT_AHEAD\`):

\`\`\`
git add -A && git commit -m "Upgrade to kortix_version 3"
git push origin HEAD
kortix cr open --head <your-branch> --title "Upgrade to kortix_version 3" --description "<the default agent and why, every file you moved or removed, each agent's grants, every item kortix migrate did not carry over and why>"
\`\`\`

If the push is rejected because the remote session branch moved, \`git fetch origin\` then \`git push --force-with-lease origin HEAD\` — your own session branch only, never any other branch.

Then run \`kortix cr diff <number>\`. If it reports no changes, your push did not land; push again and re-check (the CR updates automatically, do not open a second one).

Do **not** run \`kortix cr merge\`. Stop once the CR is open and verified non-empty, and tell the user its number so they can review the diff and merge it themselves.`;
