/**
 * `kortix ship` / `kortix cr` CLI flows (spec §14 SHIP-1..9 + §11 CR-9).
 *
 * Driven through the hermetic CLI subprocess fixture (fixtures/cli.ts).
 *
 * Runnable-now (no live git backend needed):
 *   - SHIP-7  `ship -n/--dry-run`  → prints would-be calls, NO side effects.
 *             (Logged in; the managed first-ship dry-run resolves the account via
 *             GET /accounts/me then prints the plan and returns before any write.)
 *   - SHIP-8  guards: not a Kortix dir → error; not logged in → "run kortix login".
 *             (Both are checked before any API call → pure-local, exit 1.)
 *   - ship --help → exit 0 (pure local).
 *
 * Backend-gated (self-skip locally via `requires`, verify on dev-api which has a
 * managed-git / Freestyle backend; CR-9 additionally needs a real session, so it
 * is gated on `funded`):
 *   - SHIP-1  first ship, no origin → managed: POST /projects/provision, set
 *             origin, commit, token-header push, write .kortix/link.json.
 *   - SHIP-2  first ship, existing origin → BYO: POST /projects {repo_url,name};
 *             origin never modified.
 *   - SHIP-3  first ship --origin <git-url> → BYO explicit; rewrites origin.
 *   - SHIP-4  first ship --origin freestyle → force managed even if origin exists.
 *   - SHIP-5  multi-account + --account <id|slug> mismatch → error listing slugs.
 *             (This sub-assertion IS partly runnable: --account with a bogus slug
 *             errors after GET /accounts/me — but it needs ≥1 account, so it runs
 *             logged in. The interactive-pick path can't be driven headless.)
 *   - SHIP-6  subsequent ship (linked) → GET /projects/:id; managed →
 *             POST /projects/:id/git-token then commit + push.
 *   - SHIP-9  --no-commit with a dirty tree → error (reached after provision, so
 *             gated); clean tree + HEAD → skip commit, push only.
 *   - CR-9    CLI mirror: kortix cr ls|show|open|merge|close|reopen.
 *
 * Why gate rather than mock: ke2e is black-box against a LIVE API with real
 * services. The managed-git push + provision + CR lifecycle only exist on a
 * target with the git backend (and, for CR, sandbox/session) wired. Gated flows
 * are green-or-skipped locally and exercise the real path on dev-api.
 */
import { flow } from "../core/flow";
import { assert } from "../core/expect";
import { CliSandbox } from "../fixtures/cli";

function check(description: string, pass: boolean, expected: unknown, actual: unknown): void {
  assert({ kind: "cli", description, expected, actual, pass });
}

/** Init a Kortix project in the sandbox cwd (with git) so ship has something to push. */
async function initProject(sb: CliSandbox): Promise<void> {
  const r = await sb.run(["init", "-y"]);
  if (r.exitCode !== 0) throw new Error(`init failed in ship fixture: ${r.all}`);
}

// ─────────────────────── SHIP-7 — dry-run (runnable now) ─────────────────────

flow(
  "SHIP-7",
  { domain: "cli", routes: ["GET /v1/accounts/me"] },
  async (ctx) => {
    const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-ship7") });
    const sb = new CliSandbox("ship7");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      await initProject(sb);
      const login = await sb.login(pat);
      check("login exit 0", login.exitCode === 0, 0, login.exitCode);

      await ctx.step("ship -n (managed first-ship) → prints plan, exit 0, NO side effects", async () => {
        const r = await sb.run(["ship", "-n", "-y"]);
        check("exit 0", r.exitCode === 0, 0, r.exitCode);
        check("prints a [dry-run] plan", /\[dry-run\]/i.test(r.all), true, r.stdout.slice(0, 300));
        check("plan mentions provision (managed path)", /provision/i.test(r.all), true, r.stdout.includes("provision"));
        // No side effects: no link.json written, no origin remote added.
        check("no .kortix/link.json written", !sb.exists(".kortix/link.json"), true, sb.exists(".kortix/link.json"));
        const remote = Bun.spawnSync(["git", "-C", sb.cwd, "remote"]);
        check("no git remote added", remote.stdout.toString().trim() === "", "", remote.stdout.toString().trim());
      });
    } finally {
      sb.dispose();
    }
  },
);

// ─────────────────────── SHIP-8 — guards (runnable now) ──────────────────────

flow("SHIP-8", { domain: "cli", routes: [] }, async (ctx) => {
  await ctx.step("ship outside a Kortix dir → error, exit 1 (pure-local guard)", async () => {
    const sb = new CliSandbox("ship8-nonk");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const r = await sb.run(["ship"]);
      check("exit 1", r.exitCode === 1, 1, r.exitCode);
      check("says not a Kortix project", /not a kortix project/i.test(r.all), true, r.stderr.slice(0, 200));
    } finally {
      sb.dispose();
    }
  });

  await ctx.step("ship in a Kortix dir but not logged in → 'run kortix login', exit 1", async () => {
    const sb = new CliSandbox("ship8-nologin");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const init = await sb.run(["init", "-y"]);
      check("init exit 0", init.exitCode === 0, 0, init.exitCode);
      const r = await sb.run(["ship"]);
      check("exit 1", r.exitCode === 1, 1, r.exitCode);
      check("tells the user to log in", /not logged in|kortix login/i.test(r.all), true, r.stderr.slice(0, 200));
    } finally {
      sb.dispose();
    }
  });

  await ctx.step("ship --help → exit 0 (pure local)", async () => {
    const sb = new CliSandbox("ship8-help");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const r = await sb.run(["ship", "--help"]);
      check("exit 0", r.exitCode === 0, 0, r.exitCode);
      check("prints usage", /Usage: kortix ship/.test(r.stdout), true, r.stdout.slice(0, 80));
    } finally {
      sb.dispose();
    }
  });
});

// ─────────────── SHIP-1 — first ship, no origin → managed (gated) ────────────

flow(
  "SHIP-1",
  {
    domain: "cli",
    requires: ["freestyle"],
    routes: ["GET /v1/accounts/me", "POST /v1/projects/provision"],
  },
  async (ctx) => {
    const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-ship1") });
    const sb = new CliSandbox("ship1");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      await initProject(sb);
      const login = await sb.login(pat);
      check("login exit 0", login.exitCode === 0, 0, login.exitCode);

      await ctx.step("ship -y (no origin) → managed provision, link.json + origin set", async () => {
        const r = await sb.run(["ship", "-y"], { timeoutMs: 120_000 });
        check("exit 0", r.exitCode === 0, 0, r.exitCode);
        check("wrote .kortix/link.json", sb.exists(".kortix/link.json"), true, sb.exists(".kortix/link.json"));
        const link = JSON.parse(sb.readFile(".kortix/link.json"));
        check("link.json carries project_id", typeof link.project_id === "string" && link.project_id.length > 0, true, link.project_id);
        if (link.project_id) ctx.track("project", link.project_id);
        const remote = Bun.spawnSync(["git", "-C", sb.cwd, "remote", "get-url", "origin"]);
        check("origin remote set to managed repo", remote.stdout.toString().trim().length > 0, true, remote.stdout.toString().trim());
      });
    } finally {
      sb.dispose();
    }
  },
);

// ─────────────── SHIP-2 — first ship, existing origin → BYO (gated) ──────────

flow(
  "SHIP-2",
  {
    domain: "cli",
    routes: ["GET /v1/accounts/me", "POST /v1/projects"],
  },
  async (ctx) => {
    const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-ship2") });
    const sb = new CliSandbox("ship2");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      await initProject(sb);
      // Pre-set a non-GitHub origin so ship takes the BYO POST /projects path.
      const byoUrl = "https://git.example.test/ke2e/byo.git";
      Bun.spawnSync(["git", "-C", sb.cwd, "remote", "add", "origin", byoUrl]);
      const login = await sb.login(pat);
      check("login exit 0", login.exitCode === 0, 0, login.exitCode);

      await ctx.step("ship -y with a non-GitHub origin → BYO rejected (GitHub-only), origin untouched", async () => {
        // The BYO path POSTs /projects {repo_url}, but the API only accepts a
        // GitHub repo_url (normalizeRepoUrl → resolveGitHubImport). A non-GitHub
        // origin is rejected 400 BEFORE saveLink — so ship exits non-zero, no
        // link.json is written, and (critically) the existing origin is never
        // clobbered (the single-writable-origin invariant). A real BYO happy
        // path needs a live GitHub repo + App installation (env-specific).
        const r = await sb.run(["ship", "-y"], { timeoutMs: 120_000 });
        check("ship failed — non-GitHub BYO rejected (non-zero exit)", r.exitCode !== 0, true, r.exitCode);
        check("no link.json written on failure", sb.exists(".kortix/link.json") === false, true, sb.exists(".kortix/link.json"));
        const remote = Bun.spawnSync(["git", "-C", sb.cwd, "remote", "get-url", "origin"]);
        check("origin NEVER modified (still the BYO url)", remote.stdout.toString().trim() === byoUrl, byoUrl, remote.stdout.toString().trim());
      });
    } finally {
      sb.dispose();
    }
  },
);

// ─────────────── SHIP-3 — first ship --origin <git-url> → BYO (gated) ────────

flow(
  "SHIP-3",
  {
    domain: "cli",
    routes: ["GET /v1/accounts/me", "POST /v1/projects"],
  },
  async (ctx) => {
    const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-ship3") });
    const sb = new CliSandbox("ship3");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      await initProject(sb);
      const login = await sb.login(pat);
      check("login exit 0", login.exitCode === 0, 0, login.exitCode);

      await ctx.step("ship -y --origin <non-GitHub url> → BYO rejected (GitHub-only), no link", async () => {
        // `--origin <url>` forces the BYO path; the API rejects a non-GitHub
        // repo_url (400) before saveLink AND before setOrigin (which is line-
        // ordered after the POST), so ship exits non-zero, no link.json is
        // written, and the origin is not rewritten. The happy path (origin
        // rewritten to an explicit url) needs a real GitHub repo + App.
        const explicit = "https://git.example.test/ke2e/explicit.git";
        const r = await sb.run(["ship", "-y", "--origin", explicit], { timeoutMs: 120_000 });
        check("ship failed — non-GitHub BYO rejected (non-zero exit)", r.exitCode !== 0, true, r.exitCode);
        check("no link.json written on failure", sb.exists(".kortix/link.json") === false, true, sb.exists(".kortix/link.json"));
      });
    } finally {
      sb.dispose();
    }
  },
);

// ─────────────── SHIP-4 — first ship --origin freestyle → managed (gated) ────

flow(
  "SHIP-4",
  {
    domain: "cli",
    requires: ["freestyle"],
    routes: ["GET /v1/accounts/me", "POST /v1/projects/provision"],
  },
  async (ctx) => {
    const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-ship4") });
    const sb = new CliSandbox("ship4");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      await initProject(sb);
      // Existing origin present — but --origin freestyle/managed must override it.
      Bun.spawnSync(["git", "-C", sb.cwd, "remote", "add", "origin", "https://git.example.test/ke2e/ignored.git"]);
      const login = await sb.login(pat);
      check("login exit 0", login.exitCode === 0, 0, login.exitCode);

      await ctx.step("ship -y --origin managed → force managed provision even with origin", async () => {
        // The CLI flag for forced-managed is `--origin managed` (ship.ts:
        // forceManaged = flags.origin === 'managed').
        const r = await sb.run(["ship", "-y", "--origin", "managed"], { timeoutMs: 120_000 });
        check("exit 0", r.exitCode === 0, 0, r.exitCode);
        check("link.json written (managed)", sb.exists(".kortix/link.json"), true, sb.exists(".kortix/link.json"));
        if (sb.exists(".kortix/link.json")) {
          const link = JSON.parse(sb.readFile(".kortix/link.json"));
          if (link.project_id) ctx.track("project", link.project_id);
        }
        const remote = Bun.spawnSync(["git", "-C", sb.cwd, "remote", "get-url", "origin"]);
        check("origin rewritten to the managed repo (not the ignored url)", !/ignored\.git/.test(remote.stdout.toString()), true, remote.stdout.toString().trim());
      });
    } finally {
      sb.dispose();
    }
  },
);

// ─────────────── SHIP-5 — account selection (--account mismatch) ─────────────

flow(
  "SHIP-5",
  { domain: "cli", routes: ["GET /v1/accounts/me"] },
  async (ctx) => {
    const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-ship5") });
    const sb = new CliSandbox("ship5");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      await initProject(sb);
      const login = await sb.login(pat);
      check("login exit 0", login.exitCode === 0, 0, login.exitCode);

      await ctx.step("ship --account <bogus slug> → error listing the real slugs, exit 1", async () => {
        // resolveShipAccount lists accounts via GET /accounts/me, then errors when
        // the requested account/slug isn't among them — listing the known slugs.
        const r = await sb.run(["ship", "-y", "--account", "ke2e-no-such-account-xyz"], { timeoutMs: 60_000 });
        check("exit 1", r.exitCode === 1, 1, r.exitCode);
        check("error names the missing account", /no account "ke2e-no-such-account-xyz"/i.test(r.all), true, r.stderr.slice(0, 240));
        check("no project created (no link.json)", !sb.exists(".kortix/link.json"), true, sb.exists(".kortix/link.json"));
      });
    } finally {
      sb.dispose();
    }
  },
);

// ─────────────── SHIP-6 — subsequent ship (linked, managed) (gated) ──────────

flow(
  "SHIP-6",
  {
    domain: "cli",
    requires: ["freestyle"],
    routes: [
      "GET /v1/accounts/me",
      "POST /v1/projects/provision",
      "GET /v1/projects/:projectId",
      "POST /v1/projects/:projectId/git-token",
    ],
  },
  async (ctx) => {
    const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-ship6") });
    const sb = new CliSandbox("ship6");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      await initProject(sb);
      const login = await sb.login(pat);
      check("login exit 0", login.exitCode === 0, 0, login.exitCode);

      // First ship (managed) to establish the link.
      const first = await sb.run(["ship", "-y"], { timeoutMs: 120_000 });
      check("first ship exit 0", first.exitCode === 0, 0, first.exitCode);
      check("link.json written", sb.exists(".kortix/link.json"), true, sb.exists(".kortix/link.json"));
      if (sb.exists(".kortix/link.json")) {
        const link = JSON.parse(sb.readFile(".kortix/link.json"));
        if (link.project_id) ctx.track("project", link.project_id);
      }

      await ctx.step("second ship (linked, managed) → GET /projects/:id + fresh git-token + push", async () => {
        // Make a change so there's something to commit + push.
        sb.writeFile("CHANGELOG.md", `ke2e ship-6 ${Date.now()}\n`);
        const r = await sb.run(["ship", "-y", "-m", "ke2e: ship-6 sync"], { timeoutMs: 120_000 });
        check("exit 0", r.exitCode === 0, 0, r.exitCode);
        check("reports a sync (not a new project)", /sync|shipped/i.test(r.all), true, r.stdout.slice(0, 300));
      });
    } finally {
      sb.dispose();
    }
  },
);

// ─────────────── SHIP-9 — --no-commit semantics (gated) ──────────────────────

flow(
  "SHIP-9",
  {
    domain: "cli",
    requires: ["freestyle"],
    routes: [
      "GET /v1/accounts/me",
      "POST /v1/projects/provision",
      "GET /v1/projects/:projectId",
      "POST /v1/projects/:projectId/git-token",
    ],
  },
  async (ctx) => {
    const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-ship9") });
    const sb = new CliSandbox("ship9");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      await initProject(sb);
      const login = await sb.login(pat);
      check("login exit 0", login.exitCode === 0, 0, login.exitCode);

      // Establish the link via a first managed ship (clean push of the scaffold).
      const first = await sb.run(["ship", "-y"], { timeoutMs: 120_000 });
      check("first ship exit 0", first.exitCode === 0, 0, first.exitCode);
      if (sb.exists(".kortix/link.json")) {
        const link = JSON.parse(sb.readFile(".kortix/link.json"));
        if (link.project_id) ctx.track("project", link.project_id);
      }

      await ctx.step("--no-commit with a dirty tree → error (exit 1)", async () => {
        sb.writeFile("DIRTY.md", `uncommitted ${Date.now()}\n`);
        const r = await sb.run(["ship", "-y", "--no-commit"], { timeoutMs: 120_000 });
        check("exit 1", r.exitCode === 1, 1, r.exitCode);
        check("explains dirty + --no-commit", /dirty|no-commit/i.test(r.all), true, r.stderr.slice(0, 240));
      });

      await ctx.step("--no-commit with a clean tree → skip commit, push only (exit 0)", async () => {
        // Commit the dirty file so the tree is clean, then ship --no-commit.
        Bun.spawnSync(["git", "-C", sb.cwd, "add", "-A"]);
        Bun.spawnSync(["git", "-C", sb.cwd, "commit", "-m", "ke2e: clean for ship-9"], {
          env: { ...process.env, ...sb.baseEnv() } as any,
        });
        const r = await sb.run(["ship", "-y", "--no-commit"], { timeoutMs: 120_000 });
        check("exit 0", r.exitCode === 0, 0, r.exitCode);
        check("clean tree path or push reported", /clean working tree|pushed|shipped/i.test(r.all), true, r.stdout.slice(0, 300));
      });
    } finally {
      sb.dispose();
    }
  },
);

// ─────────────── CR-9 — CLI change-request mirror (gated on a session) ───────

flow(
  "CR-9",
  {
    domain: "cli",
    requires: ["funded"],
    serial: true,
    routes: [
      "GET /v1/accounts/me",
      "POST /v1/projects/provision",
      "POST /v1/projects/:projectId/change-requests",
      "GET /v1/projects/:projectId/change-requests",
      "GET /v1/projects/:projectId/change-requests/:crId",
      "GET /v1/projects/:projectId/change-requests/:crId/merge-preview",
      "POST /v1/projects/:projectId/change-requests/:crId/merge",
      "POST /v1/projects/:projectId/change-requests/:crId/close",
      "POST /v1/projects/:projectId/change-requests/:crId/reopen",
    ],
  },
  async (ctx) => {
    // A CR needs a real project with a pushed base + a head branch (a session
    // branch). We provision the project via the API fixture (managed git), then
    // drive the CLI cr subcommands against it with KORTIX_PROJECT_ID + a
    // project-scoped token in the env (the in-sandbox contract the CLI reads).
    const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-cr9") });
    const project = await ctx.fixtures.project({ name: ctx.fixtures.name("cli-cr9-proj") });
    // A session creates the head branch the CR will propose.
    const session = await ctx.fixtures.session(project, { prompt: "ke2e cr-9 head branch" });

    const sb = new CliSandbox("cr9");
    ctx.track("cli-sandbox", sb.cwd);
    // The CLI resolves project + auth from the env inside a sandbox:
    //   KORTIX_CLI_TOKEN (project-scoped PAT) + KORTIX_PROJECT_ID.
    const crEnv = {
      KORTIX_CLI_TOKEN: pat,
      KORTIX_PROJECT_ID: project.id,
      KORTIX_API_URL: ctx.env.apiUrl,
    };
    try {
      await ctx.step("cr ls (empty) → exit 0", async () => {
        const r = await sb.run(["cr", "ls"], { env: crEnv });
        check("exit 0", r.exitCode === 0, 0, r.exitCode);
      });

      let crNumber = "";
      await ctx.step("cr open --head <session> --title → creates a CR", async () => {
        const r = await sb.run(
          ["cr", "open", "--head", session.id, "--title", "ke2e cli CR"],
          { env: crEnv },
        );
        check("exit 0", r.exitCode === 0, 0, r.exitCode);
        check("reports the opened CR number", /CR #\d+/.test(r.all), true, r.stdout.slice(0, 200));
        const m = r.stdout.match(/CR #(\d+)/);
        crNumber = m ? m[1] : "";
      });

      await ctx.step("cr show <n> + cr ls → the CR is listed", async () => {
        const ls = await sb.run(["cr", "ls", "--status", "all"], { env: crEnv });
        check("ls exit 0", ls.exitCode === 0, 0, ls.exitCode);
        if (crNumber) {
          const show = await sb.run(["cr", "show", crNumber], { env: crEnv });
          check("show exit 0", show.exitCode === 0, 0, show.exitCode);
        }
      });

      await ctx.step("cr close <n> then cr reopen <n> → lifecycle toggles", async () => {
        if (!crNumber) {
          check("CR number captured", false, "<number>", crNumber);
          return;
        }
        const close = await sb.run(["cr", "close", crNumber], { env: crEnv });
        check("close exit 0", close.exitCode === 0, 0, close.exitCode);
        const reopen = await sb.run(["cr", "reopen", crNumber], { env: crEnv });
        check("reopen exit 0", reopen.exitCode === 0, 0, reopen.exitCode);
      });
    } finally {
      sb.dispose();
    }
  },
);
