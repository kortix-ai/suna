import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const script = resolve(root, 'infra/scripts/ecs-deploy.sh');

/**
 * Drives the REAL `infra/scripts/ecs-deploy.sh` with a stubbed `aws`: the body
 * of a bash function the script imports from its environment
 * (`BASH_FUNC_aws%%`), so every call runs in the script's own shell and spawns
 * no executable. There are no AWS credentials in this environment
 * (`kortix-mfa-required` denies `ecs:DescribeServices` for the human IAM user),
 * so the stub is the only way to exercise the rollout poll end to end. Every
 * call the script makes is answered here, in the same shapes AWS CLI v2 emits
 * (`--output text` for scalars, `--output json` for documents, ISO-8601
 * timestamps).
 */
const AWS_STUB = String.raw`local ARGS="$*"
printf '%s\n' "$ARGS" >>"$AWS_STUB_LOG"

stub_service_json() {
  local rollout reason
  case "$AWS_STUB_SCENARIO" in
    rolledback|rolledback-gone)
      # The circuit breaker marked the deployment of :500 FAILED and started a
      # PRIMARY rollback deployment on :499, which completes. "gone": the
      # failed deployment already left the list.
      local failed=''
      [ "$AWS_STUB_SCENARIO" = rolledback-gone ] || failed=',
 {"status":"ACTIVE","rolloutState":"FAILED","rolloutStateReason":"ECS deployment circuit breaker: tasks failed to start.",
  "taskDefinition":"arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:500",
  "desiredCount":0,"runningCount":0,"pendingCount":0}'
      cat <<JSON
{"services":[{"status":"ACTIVE","runningCount":1,"desiredCount":1,"pendingCount":0,
"deployments":[
 {"status":"PRIMARY","rolloutState":"COMPLETED","rolloutStateReason":"ECS deployment ecs-svc/2 completed.",
  "taskDefinition":"arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:499",
  "desiredCount":1,"runningCount":1,"pendingCount":0}$failed],
"events":[{"createdAt":"2026-09-28T19:30:00+00:00","message":"STUB_EVENT_ROLLBACK (service kortix-dev-use2-web) rolling back to deployment ecs-svc/2."}]}]}
JSON
      return 0 ;;
    completed) rollout=COMPLETED; reason='ECS deployment ecs-svc/1 completed.' ;;
    failed)    rollout=FAILED;    reason='ECS deployment circuit breaker: task failed to start.' ;;
    *)         rollout=IN_PROGRESS; reason='ECS deployment ecs-svc/1 in progress.' ;;
  esac
  cat <<JSON
{"services":[{"status":"ACTIVE","runningCount":$AWS_STUB_SERVICE_RUNNING,"desiredCount":1,"pendingCount":$AWS_STUB_PENDING,
"taskDefinition":"arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:499",
"deployments":[
 {"status":"PRIMARY","rolloutState":"$rollout","rolloutStateReason":"$reason",
  "taskDefinition":"arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:500",
  "desiredCount":1,"runningCount":$AWS_STUB_RUNNING,"pendingCount":$AWS_STUB_PENDING},
 {"status":"ACTIVE","rolloutState":"COMPLETED","rolloutStateReason":"-",
  "taskDefinition":"arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:499",
  "desiredCount":1,"runningCount":1,"pendingCount":0}],
"events":[
 {"createdAt":"2026-09-18T20:04:41+00:00","message":"STUB_EVENT_NEWEST service kortix-dev-use2-web was unable to place a task."},
 {"createdAt":"2026-09-18T20:01:10+00:00","message":"STUB_EVENT_SECOND (service kortix-dev-use2-web) has started 1 tasks."}]}]}
JSON
}

stub_task_definition_json() {
  cat <<'JSON'
{"taskDefinitionArn":"arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:499",
"family":"kortix-dev-use2-web","revision":499,"status":"ACTIVE","cpu":"1024","memory":"2048",
"containerDefinitions":[{"name":"web","image":"kortix/kortix-web:old",
"environment":[{"name":"KEEP","value":"unchanged"}],"secrets":[],
"logConfiguration":{"logDriver":"awslogs","options":{
  "awslogs-group":"/ecs/kortix-dev-use2-web","awslogs-stream-prefix":"stub-prefix","awslogs-region":"us-east-2"}}}]}
JSON
}

case "$ARGS" in
  *"ecs wait services-stable"*)
    # The pre-fix behaviour, reproduced verbatim from job 105741051220 so a
    # revert fails with the incident's own message instead of "unhandled call".
    echo "Waiter ServicesStable failed: Max attempts exceeded" >&2
    return 255 ;;
  *"secretsmanager describe-secret"*)
    printf 'arn:aws:secretsmanager:us-east-2:111:secret:kortix-dev-use2-web-env-AbCdEf' ;;
  *"secretsmanager get-secret-value"*)
    printf '{"SOME_KEY":"some-value"}' ;;
  *"describe-task-definition"*)
    stub_task_definition_json ;;
  *"register-task-definition"*)
    printf 'arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:500' ;;
  *"update-service"*)
    printf '{"service":{"status":"ACTIVE"}}' ;;
  *"list-tasks"*"--desired-status RUNNING"*)
    # Tasks ECS still WANTS running — PENDING ones are returned by this filter.
    # An old task that ECS is draining has desired status STOPPED, so it is
    # absent here; "mixed" is the moment before ECS decides to stop it.
    case "$AWS_STUB_SCENARIO" in
      rolledback|rolledback-gone)
        printf '["arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/eeee5555serving-new"]\n'
        return 0 ;;
      draining)
        printf '["arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/eeee5555serving-new"]\n'
        return 0 ;;
      mixed)
        printf '["arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/eeee5555serving-new","arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/ffff6666serving-old"]\n'
        return 0 ;;
    esac
    cat <<'JSON'
[
    "arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/aaaa1111pending",
    "arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/bbbb2222pending"
]
JSON
    ;;
  *"list-tasks"*"--desired-status STOPPED"*)
    # --query taskArns --output json yields a bare, pretty-printed array.
    if [ "$AWS_STUB_STOPPED" = "none" ]; then
      printf '[]\n'
    else
      cat <<'JSON'
[
    "arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/deadbeefcafe",
    "arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/feedfacebeef",
    "arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/0ld0ld0ld"
]
JSON
    fi
    ;;
  *"describe-tasks"*serving-old*)
    cat <<'JSON'
{"tasks":[
{"taskArn":"arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/eeee5555serving-new",
"taskDefinitionArn":"arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:500",
"lastStatus":"RUNNING","desiredStatus":"RUNNING","containers":[{"name":"web","lastStatus":"RUNNING"}]},
{"taskArn":"arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/ffff6666serving-old",
"taskDefinitionArn":"arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:499",
"lastStatus":"RUNNING","desiredStatus":"RUNNING","containers":[{"name":"web","lastStatus":"RUNNING"}]}]}
JSON
    ;;
  *"describe-tasks"*serving-new*)
    cat <<'JSON'
{"tasks":[
{"taskArn":"arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/eeee5555serving-new",
"taskDefinitionArn":"arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:500",
"lastStatus":"RUNNING","desiredStatus":"RUNNING","containers":[{"name":"web","lastStatus":"RUNNING"}]}]}
JSON
    ;;
  *"describe-tasks"*pending*)
    # The PENDING wedge: nothing stopped, tasks blocked on an image pull.
    cat <<'JSON'
{"tasks":[
{"taskArn":"arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/aaaa1111pending",
"lastStatus":"PENDING","desiredStatus":"RUNNING",
"containers":[{"name":"web","lastStatus":"PENDING",
"reason":"STUB_PENDING_REASON CannotPullContainerError: manifest unknown"}]},
{"taskArn":"arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/bbbb2222pending",
"lastStatus":"PROVISIONING","desiredStatus":"RUNNING",
"containers":[{"name":"web","lastStatus":"PENDING"}]}]}
JSON
    ;;
  *"describe-tasks"*)
    cat <<'JSON'
{"tasks":[
{"taskArn":"arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/deadbeefcafe",
"taskDefinitionArn":"arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:500",
"lastStatus":"STOPPED","stopCode":"EssentialContainerExited",
"stoppedReason":"STUB_STOPPED_REASON Essential container in task exited",
"containers":[{"name":"web","exitCode":1,"reason":"STUB_CONTAINER_REASON Cannot find module 'next'"}]},
{"taskArn":"arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/feedfacebeef",
"taskDefinitionArn":"arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:500",
"lastStatus":"STOPPED","stopCode":"TaskFailedToStart",
"stoppedReason":"STUB_SECOND_STOPPED_REASON CannotPullContainerError",
"containers":[{"name":"web","exitCode":null,"reason":"STUB_NULL_EXIT_REASON image not found"}]},
{"taskArn":"arn:aws:ecs:us-east-2:111:task/kortix-dev-use2-web/0ld0ld0ld",
"taskDefinitionArn":"arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:499",
"lastStatus":"STOPPED","stopCode":"ServiceSchedulerInitiated",
"stoppedReason":"STUB_OLD_REVISION_STOPPED_REASON Scaling activity initiated by deployment",
"containers":[{"name":"web","exitCode":0}]}]}
JSON
    ;;
  *"describe-services"*"services[0].status"*)
    printf 'ACTIVE' ;;
  *"describe-services"*"services[0].taskDefinition"*)
    printf 'arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:499' ;;
  *"describe-services"*"--output table"*)
    printf 'stub summary table\n' ;;
  *"describe-services"*)
    stub_service_json ;;
  *)
    echo "stub aws: unhandled call: $ARGS" >&2
    return 64 ;;
esac
`;

/**
 * The stubs, as bash functions the script imports from its environment
 * (`BASH_FUNC_<name>%%`; macOS /bin/bash 3.2.57 imports them too). The fake
 * clock: the script reads time only through `date +%s` and waits only through
 * `sleep`, and both share one file. `sleep N` advances it by N, and `date +%s`
 * prints it. No case waits on real time, and every budget is exact in virtual
 * seconds.
 */
const STUB_FUNCTIONS = {
  'BASH_FUNC_aws%%': `() {\n${AWS_STUB}\n}`,
  'BASH_FUNC_date%%':
    '() { if [ "$*" = "+%s" ]; then local t; read -r t <"$FAKE_CLOCK" || :; echo "$t"; else command date "$@"; fi; }',
  'BASH_FUNC_sleep%%': '() { local t; read -r t <"$FAKE_CLOCK" || :; echo $(( t + $1 )) >"$FAKE_CLOCK"; }',
};
const CLOCK_START = 1_000_000;

// draining: the new task serves and the old one is draining (the service still
// counts it RUNNING). mixed: ECS still wants an old-revision task running.
type Scenario = 'completed' | 'failed' | 'stuck' | 'draining' | 'mixed' | 'rolledback' | 'rolledback-gone';

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Virtual seconds the script slept, read from the fake clock. */
  elapsedS: number;
  awsCalls: string[];
}

async function runDeploy(
  scenario: Scenario,
  env: Record<string, string> = {},
  scriptPath: string = script,
  extraArgs: string[] = [],
): Promise<RunResult> {
  // Per-case state: the stub functions read these paths from the environment.
  const dir = mkdtempSync(join(tmpdir(), 'ecs-stabilize-'));
  try {
    const log = join(dir, 'aws-calls.log');
    writeFileSync(log, '', 'utf8');
    const clock = join(dir, 'clock');
    writeFileSync(clock, String(CLOCK_START), 'utf8');

    const newDeploymentUp = scenario === 'completed' || scenario === 'draining' || scenario === 'mixed';
    // Async, so the cases of a describe run side by side: each one owns its
    // call log and fake clock.
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const args = [scriptPath, 'dev-use2', 'kortix/kortix-web:dev-ec6cbdb7', '--service', 'web', ...extraArgs];
      execFile('bash', args, { cwd: root, encoding: 'utf8', env: {
        ...process.env,
        AWS_STUB_LOG: log,
        FAKE_CLOCK: clock,
        ...STUB_FUNCTIONS,
        AWS_STUB_SCENARIO: scenario,
        // `String.raw` still interpolates ${...}, so the stub uses bare $VARs and
        // every variable it reads must be set here.
        AWS_STUB_STOPPED: 'some',
        // A never-completing rollout reports one running task and one pending.
        // While old tasks drain, the NEW deployment is complete (1/1) and the
        // service still counts the draining task (2 running, 1 desired).
        AWS_STUB_RUNNING: newDeploymentUp ? '1' : '0',
        AWS_STUB_SERVICE_RUNNING: scenario === 'completed' ? '1' : newDeploymentUp ? '2' : '0',
        AWS_STUB_PENDING: newDeploymentUp ? '0' : '1',
        ...env,
      } }, (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        done({ status: error ? (typeof code === 'number' ? code : null) : 0, stdout, stderr });
      });
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      elapsedS: Number(readFileSync(clock, 'utf8')) - CLOCK_START,
      awsCalls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.concurrent('ECS rollout stabilization budget', () => {
  it('exits 0 when the rollout reports COMPLETED with running == desired', async () => {
    const run = await runDeploy('completed', {
      ECS_STABILIZE_TIMEOUT_SECONDS: '10',
      ECS_STABILIZE_POLL_SECONDS: '1',
    });

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('✔ registered arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:500');
    expect(run.stdout).toContain('✔ update-service issued (desired count unchanged)');
    expect(run.stdout).toContain('rollout COMPLETED');
    // Nothing failed, so no diagnostics were printed.
    expect(run.stderr).not.toContain('rollout diagnostics');
    expect(run.awsCalls.some((call) => call.includes('list-tasks'))).toBe(false);
  });

  it('exits non-zero on a FAILED rollout without burning the whole budget', async () => {
    const run = await runDeploy('failed', {
      // 60s budget: a fail-fast must return in a small fraction of it.
      ECS_STABILIZE_TIMEOUT_SECONDS: '60',
      ECS_STABILIZE_POLL_SECONDS: '1',
    });

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('rollout FAILED');
    expect(run.stderr).toContain('not waiting out the remaining budget');
    expect(run.elapsedS).toBe(0);
    // The success line must not be printed for a failed roll.
    expect(run.stdout).not.toContain('now on kortix/kortix-web:dev-ec6cbdb7');
  });

  it('exits non-zero after the configured budget and prints the diagnostics a human needs', async () => {
    const run = await runDeploy('stuck', {
      ECS_STABILIZE_TIMEOUT_SECONDS: '4',
      ECS_STABILIZE_POLL_SECONDS: '1',
    });

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('did not stabilize within 4s');
    expect(run.stderr).toContain('rolloutState=IN_PROGRESS');

    // The budget is honoured exactly, not rounded up to the old fixed 600s waiter.
    expect(run.elapsedS).toBe(4);

    // Deployment detail: every deployment's counts + rolloutStateReason.
    expect(run.stderr).toContain('status=PRIMARY rolloutState=IN_PROGRESS');
    expect(run.stderr).toContain('rolloutStateReason=ECS deployment ecs-svc/1 in progress.');
    expect(run.stderr).toContain('taskDefinition=arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:500');

    // Service events, newest first, with timestamps.
    expect(run.stderr).toContain('2026-09-18T20:04:41+00:00');
    expect(run.stderr).toContain('STUB_EVENT_NEWEST');
    expect(run.stderr).toContain('STUB_EVENT_SECOND');

    // Stopped-task exit reasons: evidence that a task died and why. Their
    // absence proves nothing — see the no-stopped-tasks case below.
    // Both tasks are reported, and only real task ARNs are counted.
    // Only tasks of the revision this roll registered: the stopped task of the
    // previous revision is filtered out.
    expect(run.stderr).toContain('stopped tasks of arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:500 (newest 2)');
    expect(run.stderr).not.toContain('STUB_OLD_REVISION_STOPPED_REASON');
    expect(run.stderr).toContain('STUB_STOPPED_REASON');
    expect(run.stderr).toContain('exitCode=1');
    expect(run.stderr).toContain('STUB_CONTAINER_REASON');
    expect(run.stderr).toContain('STUB_SECOND_STOPPED_REASON');
    // A null exitCode renders as "-", never as "null".
    expect(run.stderr).toContain('exitCode=- reason=STUB_NULL_EXIT_REASON');

    // The awslogs hint, as a copy-pasteable command.
    expect(run.stderr).toContain('/ecs/kortix-dev-use2-web');
    expect(run.stderr).toContain('aws logs tail /ecs/kortix-dev-use2-web');

    // The live-task lastStatus breakdown: the signal that distinguishes a
    // PENDING wedge from a task that died. pendingCount also leads the headline.
    expect(run.stderr).toContain('live tasks by lastStatus (desired RUNNING, newest 2)');
    expect(run.stderr).toMatch(/PENDING=1 PROVISIONING=1|PROVISIONING=1 PENDING=1/);
    expect(run.stderr).toContain('STUB_PENDING_REASON');
    // A container with no reason contributes no line, keeping the output small.
    expect(run.stderr).not.toContain('bbbb2222pending lastStatus=PROVISIONING container=web reason=-');

    // Both task lists are capped, never a full dump. The stopped list scans
    // up to 100 (one describe-tasks call) to find the new revision's tasks;
    // the report above still prints at most 5.
    const listTasks = run.awsCalls.filter((call) => call.includes('list-tasks'));
    expect(listTasks).toHaveLength(2);
    expect(listTasks.filter((call) => call.includes('--desired-status RUNNING') && call.includes('--max-items 5'))).toHaveLength(1);
    expect(listTasks.filter((call) => call.includes('--desired-status STOPPED') && call.includes('--max-items 100'))).toHaveLength(1);
  });

  it('reports no-stopped-tasks as an observation and never concludes the roll is merely slow', async () => {
    // The wedge the old wording got backwards: nothing STOPPED, yet the rollout
    // is stuck because every new task is blocked in PENDING on an image pull.
    const run = await runDeploy('stuck', {
      ECS_STABILIZE_TIMEOUT_SECONDS: '4',
      ECS_STABILIZE_POLL_SECONDS: '1',
      AWS_STUB_STOPPED: 'none',
    });

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.status).not.toBe(0);

    // States the observation, and nothing more.
    expect(run.stderr).toContain('stopped tasks: none in the window — no exit reasons to report.');

    // Regression guard: the old line concluded a cause the data cannot support.
    expect(run.stderr).not.toContain('the roll is slow, not crash-looping');
    expect(run.stderr).not.toMatch(/stopped tasks: none\s*—\s*the roll is slow/);

    // Points at what would actually discriminate, without asserting which it is.
    expect(run.stderr).toContain('this does NOT mean the roll is merely slow');
    expect(run.stderr).toContain('PENDING');

    // And the discriminating evidence itself is present and names the cause.
    expect(run.stderr).toContain('live tasks by lastStatus');
    expect(run.stderr).toContain('STUB_PENDING_REASON CannotPullContainerError');
    expect(run.stderr).toContain('pending=1');
  });

  it('defaults the total budget to 900s and declares it exactly once', () => {
    const source = readFileSync(script, 'utf8');

    // The bare waiter is what failed run 35388160843 at its fixed 40x15s=600s.
    // Matches an invocation only, so the docblock may still name it.
    expect(source).not.toMatch(/^[^#\n]*\baws ecs wait\b/m);
    expect(source).toContain('ECS_STABILIZE_TIMEOUT_SECONDS="${ECS_STABILIZE_TIMEOUT_SECONDS:-900}"');
    expect(source.match(/ECS_STABILIZE_TIMEOUT_SECONDS:-/g) ?? []).toHaveLength(1);
    // No second hardcoded budget in executable code. The docblock may state it.
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'));
    expect(codeLines.filter((line) => /\b900\b/.test(line))).toHaveLength(1);
  });
});

describe.concurrent('ECS rollout --wait-for serving', () => {
  const fast = { ECS_STABILIZE_TIMEOUT_SECONDS: '4', ECS_STABILIZE_POLL_SECONDS: '1' };

  it('returns once every task ECS keeps running is on the new revision, before the old task drains', async () => {
    const run = await runDeploy('draining', { ...fast, ECS_STABILIZE_TIMEOUT_SECONDS: '10' }, script, ['--wait-for', 'serving']);

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('rollout SERVING');
    expect(run.stdout).toContain('kortix-dev-use2-web:500');
    expect(run.stdout).not.toContain('rollout COMPLETED');
  });

  it('keeps waiting while ECS still wants a task of the old revision running', async () => {
    const run = await runDeploy('mixed', fast, script, ['--wait-for', 'serving']);

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain('rollout SERVING');
    expect(run.stderr).toContain('did not stabilize within 4s');
  });

  it('keeps the default wait unchanged: a draining old task still blocks it', async () => {
    const run = await runDeploy('draining', fast);

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain('rollout SERVING');
  });

  it('still fails fast on a FAILED rollout', async () => {
    const run = await runDeploy('failed', { ...fast, ECS_STABILIZE_TIMEOUT_SECONDS: '60' }, script, ['--wait-for', 'serving']);

    expect(run.status).not.toBe(0);
    expect(run.elapsedS).toBe(0);
    expect(run.stderr).toContain('rollout FAILED');
  });

  it('rejects an unknown --wait-for value before touching AWS', async () => {
    const run = await runDeploy('completed', fast, script, ['--wait-for', 'healthy']);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--wait-for must be serving or stable');
    expect(run.awsCalls).toHaveLength(0);
  });

  it('is used by every Deploy Dev roll and by no staging or production roll', () => {
    const workflow = (name: string) => readFileSync(resolve(root, '.github/workflows', name), 'utf8');
    const devRolls = workflow('deploy-dev.yml')
      .split('\n')
      .filter((line) => line.includes('infra/scripts/ecs-deploy.sh') && !line.trim().startsWith('#') && !line.trim().startsWith('-'))
      // A --dry-run renders the task definition and rolls nothing (the release
      // gate reads its environment); only real rolls must wait for serving.
      .filter((line) => !line.includes('--dry-run'));

    expect(devRolls).toHaveLength(3);
    expect(workflow('deploy-dev.yml').match(/--wait-for serving/g)).toHaveLength(3);
    for (const name of ['deploy-staging.yml', 'deploy-prod.yml', 'rollback-prod.yml']) {
      expect(workflow(name)).not.toContain('--wait-for');
    }
  });
});

describe.concurrent('ECS rollout: only the registered revision counts', () => {
  // Dev API, 2026-09-28: the new tasks crashed, the circuit breaker rolled the
  // service back to the previous revision, and four deploys still printed
  // "rollout SERVING" on that previous revision and passed.
  const fast = { ECS_STABILIZE_TIMEOUT_SECONDS: '60', ECS_STABILIZE_POLL_SECONDS: '1' };

  for (const [mode, args] of [
    ['serving', ['--wait-for', 'serving']],
    ['stable', []],
  ] as const) {
    it(`${mode}: a circuit-breaker rollback fails fast with the new revision's stopped-task reasons`, async () => {
      const run = await runDeploy('rolledback', fast, script, [...args]);

      expect(run.stderr).not.toContain('unhandled call');
      expect(run.status).toBe(1);
      expect(run.elapsedS).toBe(0);
      expect(run.stdout).not.toMatch(/rollout (SERVING|COMPLETED)/);
      expect(run.stdout).not.toContain('now on kortix/kortix-web:dev-ec6cbdb7');
      expect(run.stderr).toContain(
        'the PRIMARY deployment runs arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:499',
      );
      expect(run.stderr).toContain('ECS deployment circuit breaker: tasks failed to start.');
      expect(run.stderr).toContain('STUB_EVENT_ROLLBACK');
      expect(run.stderr).toContain('STUB_STOPPED_REASON Essential container in task exited');
      expect(run.stderr).toContain('exitCode=1');
      expect(run.stderr).not.toContain('STUB_OLD_REVISION_STOPPED_REASON');
    });

    it(`${mode}: a rollback whose failed deployment already left the list still fails`, async () => {
      // Without the failed deployment, a PRIMARY on another revision could be
      // a stale read right after update-service, so it fails after the 60 s
      // grace, well inside the 900 s default budget.
      const run = await runDeploy('rolledback-gone', { ECS_STABILIZE_TIMEOUT_SECONDS: '900', ECS_STABILIZE_POLL_SECONDS: '15' }, script, [...args]);

      expect(run.stderr).not.toContain('unhandled call');
      expect(run.status).toBe(1);
      expect(run.elapsedS).toBe(60);
      expect(run.stdout).not.toMatch(/rollout (SERVING|COMPLETED)/);
      expect(run.stderr).toContain(
        'the PRIMARY deployment runs arn:aws:ecs:us-east-2:111:task-definition/kortix-dev-use2-web:499',
      );
    });
  }
});
