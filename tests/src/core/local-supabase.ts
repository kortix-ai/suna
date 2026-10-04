import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import type { LocalSupabaseEnvironment } from "./local-profile";
import type { LocalTopology } from "./local-topology";
import type { LocalStackHandle } from "./local-stack";

export interface LocalSupabaseHandle extends LocalStackHandle {
  environment: LocalSupabaseEnvironment;
}

interface LocalMigrationPlan {
  command: string[];
  cwd: string;
  env: Record<string, string>;
}

export function parseSupabaseEnvironment(
  output: string,
): LocalSupabaseEnvironment {
  const parsed: LocalSupabaseEnvironment = {};
  for (const line of output.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(?:"([^"]*)"|(.*))$/);
    if (!match) continue;
    const key = match[1] as keyof LocalSupabaseEnvironment;
    if (
      ![
        "API_URL",
        "DB_URL",
        "MAILPIT_URL",
        "ANON_KEY",
        "SERVICE_ROLE_KEY",
        "JWT_SECRET",
        "S3_PROTOCOL_ACCESS_KEY_ID",
        "S3_PROTOCOL_ACCESS_KEY_SECRET",
      ].includes(key)
    )
      continue;
    parsed[key] = match[2] ?? match[3] ?? "";
  }
  return parsed;
}

export function hasRequiredLocalSupabaseEnvironment(
  environment: LocalSupabaseEnvironment,
): boolean {
  return Boolean(
    environment.API_URL &&
      environment.DB_URL &&
      environment.ANON_KEY &&
      environment.SERVICE_ROLE_KEY,
  );
}

export async function readLocalSupabaseEnvironment(
  topology: LocalTopology,
): Promise<LocalSupabaseEnvironment> {
  const args = localSupabaseCommand(topology);
  args.push("status", "-o", "env");
  const processResult = Bun.spawn(args, {
    cwd: topology.root,
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(processResult.stdout).text();
  const exitCode = await processResult.exited;
  const environment = parseSupabaseEnvironment(stdout);
  // The CLI can return a non-zero status when optional services are stopped.
  // The local runner needs Auth, Postgres, and their credentials only.
  if (exitCode !== 0 && !hasRequiredLocalSupabaseEnvironment(environment)) {
    throw new Error("local Supabase is not running");
  }
  return environment;
}

function localSupabaseCommand(topology: LocalTopology): string[] {
  const args = ["supabase"];
  if (topology.marker?.dbMode === "isolated") {
    if (!topology.worktreeName) {
      throw new Error(
        "isolated worktree is missing from the worktree registry",
      );
    }
    args.push(
      "--workdir",
      join(
        process.env.KORTIX_HOME || join(homedir(), ".kortix"),
        "worktrees",
        topology.worktreeName,
        "sb",
      ),
    );
  }
  return args;
}

/**
 * One probe's output as a single reportable line, or null when it found
 * nothing. `ss` always prints its `State Recv-Q …` header, so a lone header
 * means the port is free — reporting it would be noise that reads like a
 * holder.
 */
export function formatPortProbe(port: number, tool: string, out: string): string | null {
  const rows = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^State\s+Recv-Q/.test(line));
  return rows.length > 0 ? `  ${port} ${tool}: ${rows.join(" | ")}` : null;
}

/** The host ports the local Supabase stack binds. */
const SUPABASE_PORTS = [54321, 54322, 54323, 54324] as const;

/**
 * Who holds the Supabase ports, read at the moment `supabase start` fails.
 *
 * `supabase start` reports only `address already in use` and the container it
 * could not bind — never what already had the port. That is why this failure
 * has been diagnosed three times by inference and fixed twice without
 * evidence:
 *
 *  - 2026-09-21, four runs: stale containers from a lane that skipped its
 *    teardown. Fixed by stopping on every lane (`tests.yml`).
 *  - 2026-09-21, run 35630898515: nothing left to delete — the binding simply
 *    had not been released yet. Fixed by waiting for it (`tests.yml`).
 *  - 2026-09-22, run 35701536921: the workflow's own sweep ran clean and its
 *    `::warning::` did NOT fire, so the ports were free when the job started —
 *    and `supabase start` inside `ke2e` still failed on 54322, 3.1s in.
 *
 * The workflow guards the OUTER start. This is the inner one, and nothing has
 * ever looked at the port here. Read it where it breaks rather than guessing a
 * fourth time.
 *
 * Best effort by design: this runs on an already-failing path, so a missing
 * `ss`, a missing `docker`, or a slow probe must add nothing but silence.
 */
async function describePortHolders(): Promise<string> {
  const lines: string[] = [];
  for (const port of SUPABASE_PORTS) {
    for (const argv of [
      ["ss", "-ltnp", `sport = :${port}`],
      ["docker", "ps", "-a", "--filter", `publish=${port}`, "--format", "{{.ID}} {{.Image}} {{.Status}} {{.Ports}}"],
    ]) {
      try {
        const probe = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
        const out = (await new Response(probe.stdout).text()).trim();
        await probe.exited;
        const row = formatPortProbe(port, argv[0]!, out);
        if (row) lines.push(row);
      } catch {
        /* the probe is not available here; the failure message stands alone */
      }
    }
  }
  return lines.length > 0 ? `\nports still held:\n${lines.join("\n")}` : "\nports: nothing is listening on 54321-54324";
}

export async function ensureLocalSupabase(
  topology: LocalTopology,
  options: { autoStart: boolean },
): Promise<LocalSupabaseHandle> {
  try {
    return {
      started: false,
      environment: await readLocalSupabaseEnvironment(topology),
      stop: async () => {},
    };
  } catch (error) {
    if (!options.autoStart) throw error;
  }

  const command = [
    ...localSupabaseCommand(topology),
    "start",
    "--ignore-health-check",
  ];
  const started = Bun.spawn(command, {
    cwd: topology.root,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await started.exited;
  if (exitCode !== 0) {
    throw new Error(
      `local Supabase start exited with code ${exitCode}${await describePortHolders()}`,
    );
  }
  const environment = await readLocalSupabaseEnvironment(topology);
  return {
    started: true,
    environment,
    stop: async () => {
      const stopped = Bun.spawn([...localSupabaseCommand(topology), "stop"], {
        cwd: topology.root,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      await stopped.exited;
    },
  };
}

export function localMigrationPlan(
  topology: LocalTopology,
  supabase: LocalSupabaseEnvironment,
): LocalMigrationPlan {
  if (!supabase.DB_URL) {
    throw new Error("local Supabase environment is missing DB_URL");
  }
  return {
    command: ["pnpm", "--filter", "@kortix/db", "migrate:local"],
    cwd: topology.root,
    env: {
      ...process.env,
      DATABASE_URL: supabase.DB_URL,
    },
  };
}

export async function ensureLocalMigrations(
  topology: LocalTopology,
  supabase: LocalSupabaseEnvironment,
): Promise<void> {
  const plan = localMigrationPlan(topology, supabase);
  const migrated = Bun.spawn(plan.command, {
    cwd: plan.cwd,
    env: plan.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await migrated.exited;
  if (exitCode !== 0) {
    throw new Error(`local database migration exited with code ${exitCode}`);
  }
  await waitForLocalPostgrest(supabase);
}

interface PostgrestReadinessDeps {
  reload?: (dbUrl: string) => Promise<void>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Waits until PostgREST serves the migrated schema.
 *
 * `supabase start` on an empty database boots PostgREST before the `kortix`
 * schema exists. Its first schema-cache load fails (`3F000`) and it retries
 * with exponential backoff, answering `503 PGRST002` meanwhile. Without this
 * wait, a flow that calls `/rest/v1` (SEC-K) ran inside that backoff window.
 * A `reload schema` notification loads the cache at once.
 *
 * Returns when the REST gateway is unreachable: the runner itself needs only
 * Auth and Postgres, and a flow that needs PostgREST reports its own error.
 */
export async function waitForLocalPostgrest(
  supabase: LocalSupabaseEnvironment,
  deps: PostgrestReadinessDeps = {},
): Promise<void> {
  const { API_URL, DB_URL, ANON_KEY } = supabase;
  if (!API_URL || !DB_URL || !ANON_KEY) return;
  const reload = deps.reload ?? notifyPostgrestReload;
  const request = deps.fetch ?? ((url, init) => fetch(url, init));
  const sleep = deps.sleep ?? ((ms) => Bun.sleep(ms));
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const deadline = now() + timeoutMs;
  let lastBody = "";
  for (let attempt = 0; ; attempt += 1) {
    // Re-send every 2 s: a notification that lands while PostgREST
    // reconnects is lost.
    if (attempt % 4 === 0) await reload(DB_URL).catch(() => {});
    let response: Response;
    try {
      response = await request(`${API_URL}/rest/v1/`, {
        headers: { apikey: ANON_KEY },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return;
    }
    if (response.status !== 503) return;
    lastBody = (await response.text()).slice(0, 200);
    if (now() >= deadline) {
      throw new Error(
        `local PostgREST still answers 503 after ${Math.round(timeoutMs / 1000)}s: ${lastBody}`,
      );
    }
    await sleep(500);
  }
}

async function notifyPostgrestReload(dbUrl: string): Promise<void> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query("NOTIFY pgrst, 'reload schema'");
  } finally {
    await client.end();
  }
}
