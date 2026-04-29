/**
 * Git commit + PR creation hook — fires after task_deliver.
 *
 * When a task is delivered and the working directory has modified tracked files,
 * this hook:
 *   1. Commits all changes to `kortix/agent-<sessionId>` branch
 *   2. Pushes to origin
 *   3. Opens a PR via the API's POST /v1/github/pull-request
 *   4. Returns PR metadata for SSE canvas emission
 *
 * All errors are non-fatal — git failures log at warn and the task result
 * is not affected.
 */

import { $ } from "bun"

const BACKEND_URL = process.env.KORTIX_BACKEND_URL || process.env.BACKEND_URL || "http://localhost:8008"
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ""

export interface PrHookResult {
  pr_url: string
  pr_number: number
  branch: string
  diff_additions: number
  diff_deletions: number
  ci_status: "pending" | "pass" | "fail" | null
}

/** Convert a task title into a slug: first 6 words, lowercased, hyphenated, max 40 chars */
function taskSlug(title: string): string {
  const words = title.toLowerCase().replace(/[^\w\s-]/g, "").trim().split(/\s+/)
  return words.slice(0, 6).join("-").slice(0, 40)
}

/** Run a shell command in a given directory. Returns stdout on success, null on error. */
async function runGit(args: string[], cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" })
    if (!proc.success) return null
    return proc.stdout.toString().trim()
  } catch {
    return null
  }
}

export async function runGitPrHook(params: {
  sessionId: string
  taskTitle: string
  directory: string
}): Promise<PrHookResult | null> {
  const { sessionId, taskTitle, directory } = params

  // ── 1. Check for modified tracked files ────────────────────────────────────
  const statusOut = await runGit(["status", "--porcelain"], directory)
  if (statusOut === null || statusOut.trim() === "") {
    // No git or no changes — skip silently
    return null
  }

  // ── 2. Get default branch and remote ───────────────────────────────────────
  const remote = await runGit(["remote"], directory)
  if (!remote || remote.trim() === "") {
    // No remote configured — skip silently (per AC)
    console.debug("[git-pr] No git remote configured in sandbox, skipping PR flow")
    return null
  }

  const defaultBranch =
    (await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], directory))
      ?.replace("origin/", "")
    ?? (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], directory))
    ?? "main"

  const repoLine = await runGit(["remote", "get-url", "origin"], directory)
  // Parse "owner/repo" from various GitHub URL formats
  const repoMatch = repoLine?.match(/github\.com[:/]([^/]+\/[^/.]+)/)
  const repo = repoMatch?.[1] ?? null

  // ── 3. Branch, add, commit ─────────────────────────────────────────────────
  const branch = `kortix/agent-${sessionId}`
  const slug = taskSlug(taskTitle)
  const commitMsg = `kortix: ${slug}`

  const checkoutOk = await runGit(["checkout", "-b", branch], directory)
    ?? await runGit(["checkout", branch], directory)

  if (checkoutOk === null) {
    console.warn(`[git-pr] Failed to checkout branch ${branch}`)
    return null
  }

  await runGit(["add", "-A"], directory)

  const commitOut = await runGit(["commit", "-m", commitMsg], directory)
  if (commitOut === null) {
    console.warn("[git-pr] git commit failed")
    return null
  }

  // ── 4. Push ────────────────────────────────────────────────────────────────
  const pushOut = await runGit(["push", "origin", branch], directory)
  if (pushOut === null) {
    console.warn(`[git-pr] git push failed for branch ${branch} — PR not created`)
    return null
  }

  if (!repo) {
    console.warn("[git-pr] Cannot determine GitHub repo from remote URL — PR not created")
    return null
  }

  // ── 5. Open PR via /v1/github/pull-request ─────────────────────────────────
  try {
    const prRes = await fetch(`${BACKEND_URL}/v1/github/pull-request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(INTERNAL_SERVICE_KEY ? { Authorization: `Bearer ${INTERNAL_SERVICE_KEY}` } : {}),
      },
      body: JSON.stringify({
        repo,
        branch,
        base: defaultBranch,
        title: taskTitle,
        body: `Opened by Kortix agent session ${sessionId}`,
      }),
      signal: AbortSignal.timeout(20_000),
    })

    if (!prRes.ok) {
      const text = await prRes.text()
      console.warn(`[git-pr] PR creation failed (${prRes.status}): ${text}`)
      return null
    }

    const prData = await prRes.json() as {
      pr_url: string
      pr_number: number
      ci_status: "pending" | "pass" | "fail" | null
    }

    // ── 6. Fetch diff stats from GitHub PR endpoint ────────────────────────
    let diff_additions = 0
    let diff_deletions = 0
    try {
      const token = process.env.GITHUB_TOKEN
      if (token) {
        const prDetailRes = await fetch(
          `https://api.github.com/repos/${repo}/pulls/${prData.pr_number}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            signal: AbortSignal.timeout(8_000),
          },
        )
        if (prDetailRes.ok) {
          const detail = await prDetailRes.json() as { additions: number; deletions: number }
          diff_additions = detail.additions ?? 0
          diff_deletions = detail.deletions ?? 0
        }
      }
    } catch {
      // non-blocking — diff stays 0
    }

    const result: PrHookResult = {
      pr_url: prData.pr_url,
      pr_number: prData.pr_number,
      branch,
      diff_additions,
      diff_deletions,
      ci_status: prData.ci_status,
    }

    // ── 7. Emit canvas pr_summary event via Kortix API ────────────────────
    try {
      const canvasEvent = {
        type: "canvas",
        kind: "pr_summary",
        id: `pr_summary:${sessionId}:${prData.pr_number}`,
        data: {
          pr_url: prData.pr_url,
          pr_number: prData.pr_number,
          branch,
          diff_additions,
          diff_deletions,
          ci_status: prData.ci_status,
        },
      }

      await fetch(`${BACKEND_URL}/v1/canvas/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(INTERNAL_SERVICE_KEY ? { Authorization: `Bearer ${INTERNAL_SERVICE_KEY}` } : {}),
        },
        body: JSON.stringify(canvasEvent),
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
      // non-blocking — canvas emit is best-effort
    }

    return result
  } catch (err) {
    console.warn("[git-pr] PR creation error:", err instanceof Error ? err.message : String(err))
    return null
  }
}
