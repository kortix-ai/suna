/**
 * `kortix` CLI — local + auth flows (spec §2).
 *
 * These map 1:1 to the CLI spec IDs and are driven through the hermetic CLI
 * subprocess fixture (fixtures/cli.ts): a throwaway cwd + a private config file,
 * the CLI source entry invoked via `bun run` (never a stale binary), and the
 * ke2e target wired in via KORTIX_DEFAULT_API_BASE.
 *
 * Split of work:
 *   - INIT-1..4, CREATE-1, HOSTS-1..6, LOGOUT-1 are PURE-LOCAL — they make ZERO
 *     API calls (verified against init.ts / create.ts / hosts.ts / logout.ts /
 *     config.ts), so `routes: []`. We assert scaffolding + config-file effects +
 *     exit codes directly.
 *   - LOGIN-1/3/4 + WHOAMI-1 hit `GET /accounts/me` (login validates the PAT;
 *     whoami prints identity). They mint a real OWNER PAT via ctx.fixtures.pat()
 *     (POST /v1/accounts/tokens) and run the real command against the target.
 *   - LOGIN-2 (browser/one-shot localhost callback) is driven WITHOUT a browser
 *     by simulating the dashboard's callback POST (see fixtures/cli.browserLogin).
 *
 * The assert surface (status-code) is intentionally tolerant where the CLI's
 * exit code is the contract; the API side-effect is pinned by the declared
 * `routes` so the coverage gate still counts the GET /accounts/me hit.
 */
import { flow } from "../core/flow";
import { assert } from "../core/expect";
import { CliSandbox, browserLogin } from "../fixtures/cli";

/** Tiny structured assert that records into the active step. */
function check(description: string, pass: boolean, expected: unknown, actual: unknown): void {
  assert({ kind: "cli", description, expected, actual, pass });
}

// ───────────────────────────── INIT ─────────────────────────────────────────

flow("INIT-1", { domain: "cli", routes: [] }, async (ctx) => {
  await ctx.step("kortix init -y in an empty dir → scaffold + git init, exit 0, ZERO API", async () => {
    const sb = new CliSandbox("init1");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const r = await sb.run(["init", "-y"]);
      check("exit 0", r.exitCode === 0, 0, r.exitCode);
      check("kortix.toml written", sb.exists("kortix.toml"), true, sb.exists("kortix.toml"));
      check(".kortix/ written", sb.exists(".kortix"), true, sb.exists(".kortix"));
      check(
        ".kortix/opencode/ runtime dir written (default agent + config)",
        sb.exists(".kortix/opencode/opencode.jsonc"),
        true,
        sb.exists(".kortix/opencode/opencode.jsonc"),
      );
      // codex is the default primary → AGENTS.md pointer is wired.
      check("AGENTS.md (codex default) wired", sb.exists("AGENTS.md"), true, sb.exists("AGENTS.md"));
      check("git init -b main ran (.git exists)", sb.exists(".git"), true, sb.exists(".git"));
    } finally {
      sb.dispose();
    }
  });
});

flow("INIT-2", { domain: "cli", routes: [] }, async (ctx) => {
  await ctx.step("kortix init when kortix.toml exists, no --force → exit 1 (refuses)", async () => {
    const sb = new CliSandbox("init2");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const first = await sb.run(["init", "-y", "--no-git"]);
      check("first init exit 0", first.exitCode === 0, 0, first.exitCode);
      const second = await sb.run(["init", "-y", "--no-git"]);
      check("re-init without --force → exit 1", second.exitCode === 1, 1, second.exitCode);
      check("refusal mentions existing kortix.toml", /already has a kortix\.toml/i.test(second.all), true, second.stderr.slice(0, 200));
    } finally {
      sb.dispose();
    }
  });
});

flow("INIT-3", { domain: "cli", routes: [] }, async (ctx) => {
  await ctx.step(
    "kortix init --primary opencode --agents claude,cursor -y → primary + extra agent wiring",
    async () => {
      const sb = new CliSandbox("init3");
      ctx.track("cli-sandbox", sb.cwd);
      try {
        const r = await sb.run(["init", "--primary", "opencode", "--agents", "claude,cursor", "-y", "--no-git"]);
        check("exit 0", r.exitCode === 0, 0, r.exitCode);
        // Primary opencode → .opencode/skills/kortix wrapper; extras → .claude + .cursor.
        check("opencode skill wired", sb.exists(".opencode/skills/kortix"), true, sb.exists(".opencode/skills/kortix"));
        check("claude skill wired", sb.exists(".claude/skills/kortix"), true, sb.exists(".claude/skills/kortix"));
        check(
          "cursor rule wired",
          sb.exists(".cursor/rules/kortix.mdc"),
          true,
          sb.exists(".cursor/rules/kortix.mdc"),
        );
      } finally {
        sb.dispose();
      }
    },
  );
});

flow("INIT-4", { domain: "cli", routes: [] }, async (ctx) => {
  await ctx.step("kortix init --no-git → no repo created", async () => {
    const sb = new CliSandbox("init4");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const r = await sb.run(["init", "-y", "--no-git"]);
      check("exit 0", r.exitCode === 0, 0, r.exitCode);
      check("scaffold written", sb.exists("kortix.toml"), true, sb.exists("kortix.toml"));
      check("NO .git created", !sb.exists(".git"), false, sb.exists(".git"));
    } finally {
      sb.dispose();
    }
  });
});

// ───────────────────────────── CREATE ───────────────────────────────────────

flow("CREATE-1", { domain: "cli", routes: [] }, async (ctx) => {
  await ctx.step("kortix <name> (bare) → sibling dir + scaffold + git init + initial commit", async () => {
    const sb = new CliSandbox("create1");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const r = await sb.run(["mywidget"]);
      check("exit 0", r.exitCode === 0, 0, r.exitCode);
      check("sibling dir scaffolded (kortix.toml)", sb.exists("mywidget/kortix.toml"), true, sb.exists("mywidget/kortix.toml"));
      check("git init ran in new dir", sb.exists("mywidget/.git"), true, sb.exists("mywidget/.git"));
      // create.ts makes the initial commit `chore: init kortix project` — verify it
      // landed (git identity is provided via the sandbox's GIT_* env).
      const git = Bun.spawnSync(["git", "-C", `${sb.cwd}/mywidget`, "log", "--oneline"]);
      const out = git.stdout.toString();
      check("initial commit present", /chore: init kortix project/.test(out), true, out.trim().slice(0, 120));
    } finally {
      sb.dispose();
    }
  });

  await ctx.step("reserved subcommand name (e.g. `tunnel`) → exit 2 (not a project scaffold)", async () => {
    const sb = new CliSandbox("create1-reserved");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const r = await sb.run(["tunnel"]);
      check("reserved name → exit 2", r.exitCode === 2, 2, r.exitCode);
      check("no `tunnel/` dir scaffolded", !sb.exists("tunnel"), true, sb.exists("tunnel"));
    } finally {
      sb.dispose();
    }
  });
});

// ───────────────────────────── HOSTS ────────────────────────────────────────
// All hosts subcommands are config-only (config.ts) — ZERO API calls.

flow("HOSTS-1", { domain: "cli", routes: [] }, async (ctx) => {
  await ctx.step("kortix hosts ls → lists built-in hosts, exit 0", async () => {
    const sb = new CliSandbox("hosts-ls");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const r = await sb.run(["hosts", "ls"]);
      check("exit 0", r.exitCode === 0, 0, r.exitCode);
      // Built-ins always exist: cloud, selfhost, local-dev, kortix-internal-dev.
      check("lists cloud", /\bcloud\b/.test(r.stdout), true, r.stdout.includes("cloud"));
      check("lists local-dev", /local-dev/.test(r.stdout), true, r.stdout.includes("local-dev"));
    } finally {
      sb.dispose();
    }
  });
});

flow("HOSTS-2", { domain: "cli", routes: [] }, async (ctx) => {
  await ctx.step("kortix hosts use <name> → switches active host", async () => {
    const sb = new CliSandbox("hosts-use");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const r = await sb.run(["hosts", "use", "local-dev"]);
      check("exit 0", r.exitCode === 0, 0, r.exitCode);
      const cur = await sb.run(["hosts", "current"]);
      check("active host now local-dev", cur.stdout.trim() === "local-dev", "local-dev", cur.stdout.trim());
      // Unknown host → error, exit 1.
      const bad = await sb.run(["hosts", "use", "nope-not-a-host"]);
      check("unknown host → exit 1", bad.exitCode === 1, 1, bad.exitCode);
    } finally {
      sb.dispose();
    }
  });
});

flow("HOSTS-3", { domain: "cli", routes: [] }, async (ctx) => {
  await ctx.step("kortix hosts add <name> --url <url> → registers a placeholder host", async () => {
    const sb = new CliSandbox("hosts-add");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const r = await sb.run(["hosts", "add", "scratch", "--url", "http://localhost:9999"]);
      check("exit 0", r.exitCode === 0, 0, r.exitCode);
      const info = await sb.run(["hosts", "info", "scratch"]);
      check("new host has the URL", /localhost:9999/.test(info.stdout), true, info.stdout.includes("9999"));
      // Adding the same name again → refuses (exit 1).
      const dup = await sb.run(["hosts", "add", "scratch", "--url", "http://localhost:1234"]);
      check("duplicate add → exit 1", dup.exitCode === 1, 1, dup.exitCode);
    } finally {
      sb.dispose();
    }
  });
});

flow("HOSTS-4", { domain: "cli", routes: [] }, async (ctx) => {
  await ctx.step("kortix hosts rm <name> → removes a custom host; built-ins reset", async () => {
    const sb = new CliSandbox("hosts-rm");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      await sb.run(["hosts", "add", "scratch", "--url", "http://localhost:9999"]);
      const r = await sb.run(["hosts", "rm", "scratch", "--force"]);
      check("rm exit 0", r.exitCode === 0, 0, r.exitCode);
      const info = await sb.run(["hosts", "info", "scratch"]);
      check("custom host gone (info → exit 1)", info.exitCode === 1, 1, info.exitCode);
      // Unknown host → error, exit 1.
      const bad = await sb.run(["hosts", "rm", "nope-not-a-host", "--force"]);
      check("rm unknown → exit 1", bad.exitCode === 1, 1, bad.exitCode);
    } finally {
      sb.dispose();
    }
  });
});

flow("HOSTS-5", { domain: "cli", routes: [] }, async (ctx) => {
  await ctx.step("kortix hosts info [<name>] → shows one host", async () => {
    const sb = new CliSandbox("hosts-info");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const r = await sb.run(["hosts", "info", "cloud"]);
      check("exit 0", r.exitCode === 0, 0, r.exitCode);
      check("shows the cloud host url line", /url\s+http/i.test(r.stdout), true, r.stdout.slice(0, 120));
      // No-arg info → falls back to the active host.
      const active = await sb.run(["hosts", "info"]);
      check("info (no arg) → exit 0 for active host", active.exitCode === 0, 0, active.exitCode);
    } finally {
      sb.dispose();
    }
  });
});

flow("HOSTS-6", { domain: "cli", routes: [] }, async (ctx) => {
  await ctx.step("kortix hosts current → prints the active host name", async () => {
    const sb = new CliSandbox("hosts-current");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const r = await sb.run(["hosts", "current"]);
      check("exit 0", r.exitCode === 0, 0, r.exitCode);
      // Fresh config → the default active host is `cloud`.
      check("active host is cloud by default", r.stdout.trim() === "cloud", "cloud", r.stdout.trim());
    } finally {
      sb.dispose();
    }
  });
});

// ───────────────────────────── LOGOUT ───────────────────────────────────────

flow("LOGOUT-1", { domain: "cli", routes: [] }, async (ctx) => {
  await ctx.step("kortix logout → removes host creds (no API); not-logged-in is a no-op", async () => {
    const sb = new CliSandbox("logout1");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      // Seed a fake logged-in `cloud` host directly in the private config so we
      // can assert logout clears it — WITHOUT any API call (LOGOUT-1 is local).
      const cfg = {
        active: "cloud",
        hosts: {
          cloud: {
            url: "http://localhost:8008",
            token: "kortix_pat_fake_for_logout_only",
            user_id: "u",
            user_email: "u@example.com",
            account_id: "a",
            logged_in_at: new Date().toISOString(),
          },
        },
      };
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      mkdirSync(dirname(sb.configFile), { recursive: true });
      writeFileSync(sb.configFile, JSON.stringify(cfg, null, 2), "utf8");
      check("seeded config is logged in", sb.isLoggedIn(), true, sb.isLoggedIn());

      const r = await sb.run(["logout"]);
      check("logout exit 0", r.exitCode === 0, 0, r.exitCode);
      // cloud is a built-in → reset to a token-less placeholder (not removed).
      check("active host token cleared", !sb.isLoggedIn(), true, sb.isLoggedIn());

      // Second logout → no-op, still exit 0.
      const again = await sb.run(["logout"]);
      check("second logout → exit 0 (no-op)", again.exitCode === 0, 0, again.exitCode);
    } finally {
      sb.dispose();
    }
  });
});

// ─────────────────────────── LOGIN / WHOAMI ─────────────────────────────────
// These hit GET /accounts/me. They self-skip if the auth'd matrix isn't
// provisioned (the OWNER PAT mint requires Supabase-admin world setup).

flow("LOGIN-1", { domain: "cli", routes: ["GET /v1/accounts/me"] }, async (ctx) => {
  const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-login1") });
  const sb = new CliSandbox("login1");
  ctx.track("cli-sandbox", sb.cwd);
  try {
    await ctx.step("kortix login --token <valid PAT> → validates via /accounts/me, saves host", async () => {
      const r = await sb.login(pat);
      check("exit 0", r.exitCode === 0, 0, r.exitCode);
      check("reports logged in", /logged in/i.test(r.all), true, r.stdout.slice(0, 200));
      check("config now carries a token", sb.isLoggedIn(), true, sb.isLoggedIn());
    });
    await ctx.step("config file written mode 0600", async () => {
      const { statSync } = await import("node:fs");
      const mode = statSync(sb.configFile).mode & 0o777;
      // chmod is best-effort (skipped on Windows); on POSIX it must be 0600.
      check("config file is 0600", mode === 0o600, 0o600, mode.toString(8));
    });
  } finally {
    sb.dispose();
  }
});

flow("LOGIN-2", { domain: "cli", routes: ["GET /v1/accounts/me"] }, async (ctx) => {
  const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-login2") });
  await ctx.step(
    "kortix login (browser) → one-shot localhost callback; dashboard POSTs {state,token} → saved",
    async () => {
      const sb = new CliSandbox("login2");
      ctx.track("cli-sandbox", sb.cwd);
      try {
        const r = await browserLogin(sb, pat);
        check("printed an authorize URL with state + callback", /cli\/authorize\?callback=/.test(r.stdout), true, r.stdout.includes("cli/authorize"));
        check("exit 0 after callback delivered", r.exitCode === 0, 0, r.exitCode);
        check("config now carries a token", sb.isLoggedIn(), true, sb.isLoggedIn());
      } finally {
        sb.dispose();
      }
    },
  );
  await ctx.step("state-mismatch callback → rejected, login does NOT save", async () => {
    const sb = new CliSandbox("login2-bad");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const r = await browserLogin(sb, pat, { badState: true });
      check("non-zero exit (timeout / rejected)", r.exitCode !== 0, "!=0", r.exitCode);
      check("config NOT logged in", !sb.isLoggedIn(), true, sb.isLoggedIn());
    } finally {
      sb.dispose();
    }
  });
});

flow("LOGIN-3", { domain: "cli", routes: ["GET /v1/accounts/me"] }, async (ctx) => {
  await ctx.step("kortix login --token <bad valid-prefix> → /accounts/me 401 → exit 1", async () => {
    const sb = new CliSandbox("login3");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      // A well-formed-but-bogus PAT: passes the kortix_pat_ prefix check, gets
      // rejected by GET /accounts/me (401).
      const r = await sb.login("kortix_pat_ke2e_definitely_not_a_real_token_000000");
      check("exit 1", r.exitCode === 1, 1, r.exitCode);
      check("reports token rejected", /rejected/i.test(r.all), true, r.stderr.slice(0, 200));
      check("config NOT logged in", !sb.isLoggedIn(), true, sb.isLoggedIn());
    } finally {
      sb.dispose();
    }
  });

  await ctx.step("kortix login --token <bad prefix> → rejected locally (no API call), exit 1", async () => {
    const sb = new CliSandbox("login3-prefix");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const r = await sb.run(["login", "--token", "notapat"]);
      check("exit 1", r.exitCode === 1, 1, r.exitCode);
      check("reports invalid format", /format|prefix/i.test(r.all), true, r.stderr.slice(0, 200));
    } finally {
      sb.dispose();
    }
  });
});

flow("LOGIN-4", { domain: "cli", routes: ["GET /v1/accounts/me"] }, async (ctx) => {
  const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-login4") });
  await ctx.step("already-logged-in host, no flags → no-op (still exit 0, token unchanged)", async () => {
    const sb = new CliSandbox("login4");
    ctx.track("cli-sandbox", sb.cwd);
    try {
      const first = await sb.login(pat);
      check("first login exit 0", first.exitCode === 0, 0, first.exitCode);
      const token1 = sb.readConfig()?.hosts?.[sb.readConfig()?.active]?.token;

      // Re-run login with NO flags → should short-circuit as a no-op.
      const second = await sb.run(["login"]);
      check("second login exit 0 (no-op)", second.exitCode === 0, 0, second.exitCode);
      check("reports already logged in", /already logged in/i.test(second.all), true, second.stdout.slice(0, 200));
      const token2 = sb.readConfig()?.hosts?.[sb.readConfig()?.active]?.token;
      check("token unchanged by no-op", token1 === token2, token1, token2);
    } finally {
      sb.dispose();
    }
  });
});

flow("WHOAMI-1", { domain: "cli", routes: ["GET /v1/accounts/me"] }, async (ctx) => {
  const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-whoami") });
  const sb = new CliSandbox("whoami1");
  ctx.track("cli-sandbox", sb.cwd);
  try {
    await ctx.step("logged in → kortix whoami prints email/user_id/account", async () => {
      const login = await sb.login(pat);
      check("login exit 0", login.exitCode === 0, 0, login.exitCode);
      const r = await sb.run(["whoami"]);
      check("exit 0", r.exitCode === 0, 0, r.exitCode);
      check("prints user_id line", /user_id/.test(r.stdout), true, r.stdout.includes("user_id"));
      check("prints host line", /host\s/i.test(r.stdout), true, r.stdout.includes("host"));
    });
    await ctx.step("not logged in → whoami → exit 1 with re-login prompt", async () => {
      const fresh = new CliSandbox("whoami1-anon");
      ctx.track("cli-sandbox", fresh.cwd);
      try {
        const r = await fresh.run(["whoami"]);
        check("exit 1", r.exitCode === 1, 1, r.exitCode);
        check("prompts to log in", /not logged in|kortix login/i.test(r.all), true, r.stderr.slice(0, 200));
      } finally {
        fresh.dispose();
      }
    });
  } finally {
    sb.dispose();
  }
});
