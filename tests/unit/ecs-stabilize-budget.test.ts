import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const script = resolve(root, 'infra/scripts/ecs-deploy.sh');

/**
 * Drives the REAL `infra/scripts/ecs-deploy.sh` with a stubbed `aws` executable
 * placed earlier on PATH. There are no AWS credentials in this environment
 * (`kortix-mfa-required` denies `ecs:DescribeServices` for the human IAM user),
 * so the stub is the only way to exercise the rollout poll end to end. Every
 * call the script makes is answered here, in the same shapes AWS CLI v2 emits
 * (`--output text` for scalars, `--output json` for documents, ISO-8601
 * timestamps).
 */
const AWS_STUB = String.raw`#!/usr/bin/env bash
set -euo pipefail
ARGS="$*"
printf '%s\n' "$ARGS" >>"$AWS_STUB_LOG"

service_json() {
  local rollout reason
  case "$AWS_STUB_SCENARIO" in
    completed) rollout=COMPLETED; reason='ECS deployment ecs-svc/1 completed.' ;;
    failed)    rollout=FAILED;    reason='ECS deployment circuit breaker: task failed to start.' ;;
    *)         rollout=IN_PROGRESS; reason='ECS deployment ecs-svc/1 in progress.' ;;
  esac
  cat <<JSON
{"services":[{"status":"ACTIVE","runningCount":$AWS_STUB_RUNNING,"desiredCount":1,"pendingCount":$AWS_STUB_PENDING,
"taskDefinition":"arn:aws:ecs:us-west-2:111:task-definition/kortix-dev-web:499",
"deployments":[
 {"status":"PRIMARY","rolloutState":"$rollout","rolloutStateReason":"$reason",
  "taskDefinition":"arn:aws:ecs:us-west-2:111:task-definition/kortix-dev-web:500",
  "desiredCount":1,"runningCount":$AWS_STUB_RUNNING,"pendingCount":$AWS_STUB_PENDING},
 {"status":"ACTIVE","rolloutState":"COMPLETED","rolloutStateReason":"-",
  "taskDefinition":"arn:aws:ecs:us-west-2:111:task-definition/kortix-dev-web:499",
  "desiredCount":1,"runningCount":1,"pendingCount":0}],
"events":[
 {"createdAt":"2026-09-18T20:04:41+00:00","message":"STUB_EVENT_NEWEST service kortix-dev-web was unable to place a task."},
 {"createdAt":"2026-09-18T20:01:10+00:00","message":"STUB_EVENT_SECOND (service kortix-dev-web) has started 1 tasks."}]}]}
JSON
}

task_definition_json() {
  cat <<'JSON'
{"taskDefinitionArn":"arn:aws:ecs:us-west-2:111:task-definition/kortix-dev-web:499",
"family":"kortix-dev-web","revision":499,"status":"ACTIVE","cpu":"1024","memory":"2048",
"containerDefinitions":[{"name":"web","image":"kortix/kortix-web:old",
"environment":[{"name":"KEEP","value":"unchanged"}],"secrets":[],
"logConfiguration":{"logDriver":"awslogs","options":{
  "awslogs-group":"/ecs/kortix-dev-web","awslogs-stream-prefix":"stub-prefix","awslogs-region":"us-west-2"}}}]}
JSON
}

case "$ARGS" in
  *"ecs wait services-stable"*)
    # The pre-fix behaviour, reproduced verbatim from job 105741051220 so a
    # revert fails with the incident's own message instead of "unhandled call".
    echo "Waiter ServicesStable failed: Max attempts exceeded" >&2
    exit 255 ;;
  *"secretsmanager describe-secret"*)
    printf 'arn:aws:secretsmanager:us-west-2:111:secret:kortix-dev-web-env-AbCdEf' ;;
  *"secretsmanager get-secret-value"*)
    printf '{"SOME_KEY":"some-value"}' ;;
  *"describe-task-definition"*)
    task_definition_json ;;
  *"register-task-definition"*)
    printf 'arn:aws:ecs:us-west-2:111:task-definition/kortix-dev-web:500' ;;
  *"update-service"*)
    printf '{"service":{"status":"ACTIVE"}}' ;;
  *"list-tasks"*"--desired-status RUNNING"*)
    # Tasks ECS still WANTS running — PENDING ones are returned by this filter.
    cat <<'JSON'
[
    "arn:aws:ecs:us-west-2:111:task/kortix-dev-web/aaaa1111pending",
    "arn:aws:ecs:us-west-2:111:task/kortix-dev-web/bbbb2222pending"
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
    "arn:aws:ecs:us-west-2:111:task/kortix-dev-web/deadbeefcafe",
    "arn:aws:ecs:us-west-2:111:task/kortix-dev-web/feedfacebeef"
]
JSON
    fi
    ;;
  *"describe-tasks"*pending*)
    # The PENDING wedge: nothing stopped, tasks blocked on an image pull.
    cat <<'JSON'
{"tasks":[
{"taskArn":"arn:aws:ecs:us-west-2:111:task/kortix-dev-web/aaaa1111pending",
"lastStatus":"PENDING","desiredStatus":"RUNNING",
"containers":[{"name":"web","lastStatus":"PENDING",
"reason":"STUB_PENDING_REASON CannotPullContainerError: manifest unknown"}]},
{"taskArn":"arn:aws:ecs:us-west-2:111:task/kortix-dev-web/bbbb2222pending",
"lastStatus":"PROVISIONING","desiredStatus":"RUNNING",
"containers":[{"name":"web","lastStatus":"PENDING"}]}]}
JSON
    ;;
  *"describe-tasks"*)
    cat <<'JSON'
{"tasks":[
{"taskArn":"arn:aws:ecs:us-west-2:111:task/kortix-dev-web/deadbeefcafe",
"lastStatus":"STOPPED","stopCode":"EssentialContainerExited",
"stoppedReason":"STUB_STOPPED_REASON Essential container in task exited",
"containers":[{"name":"web","exitCode":1,"reason":"STUB_CONTAINER_REASON Cannot find module 'next'"}]},
{"taskArn":"arn:aws:ecs:us-west-2:111:task/kortix-dev-web/feedfacebeef",
"lastStatus":"STOPPED","stopCode":"TaskFailedToStart",
"stoppedReason":"STUB_SECOND_STOPPED_REASON CannotPullContainerError",
"containers":[{"name":"web","exitCode":null,"reason":"STUB_NULL_EXIT_REASON image not found"}]}]}
JSON
    ;;
  *"describe-services"*"services[0].status"*)
    printf 'ACTIVE' ;;
  *"describe-services"*"services[0].taskDefinition"*)
    printf 'arn:aws:ecs:us-west-2:111:task-definition/kortix-dev-web:499' ;;
  *"describe-services"*"--output table"*)
    printf 'stub summary table\n' ;;
  *"describe-services"*)
    service_json ;;
  *)
    echo "stub aws: unhandled call: $ARGS" >&2
    exit 64 ;;
esac
`;

type Scenario = 'completed' | 'failed' | 'stuck';

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  awsCalls: string[];
}

function runDeploy(
  scenario: Scenario,
  env: Record<string, string> = {},
  scriptPath: string = script,
): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-stabilize-'));
  const bin = join(dir, 'aws');
  const log = join(dir, 'aws-calls.log');
  writeFileSync(bin, AWS_STUB, 'utf8');
  chmodSync(bin, 0o755);
  writeFileSync(log, '', 'utf8');

  const startedAt = Date.now();
  const result = spawnSync('bash', [scriptPath, 'dev', 'kortix/kortix-web:dev-ec6cbdb7', '--service', 'web'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      AWS_STUB_LOG: log,
      AWS_STUB_SCENARIO: scenario,
      // `String.raw` still interpolates ${...}, so the stub uses bare $VARs and
      // every variable it reads must be set here.
      AWS_STUB_STOPPED: 'some',
      // A never-completing rollout reports one running task and one pending.
      AWS_STUB_RUNNING: scenario === 'completed' ? '1' : '0',
      AWS_STUB_PENDING: scenario === 'completed' ? '0' : '1',
      ...env,
    },
  });
  const elapsedMs = Date.now() - startedAt;

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    elapsedMs,
    awsCalls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

describe('ECS rollout stabilization budget', () => {
  it('exits 0 when the rollout reports COMPLETED with running == desired', () => {
    const run = runDeploy('completed', {
      ECS_STABILIZE_TIMEOUT_SECONDS: '10',
      ECS_STABILIZE_POLL_SECONDS: '1',
    });

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('✔ registered arn:aws:ecs:us-west-2:111:task-definition/kortix-dev-web:500');
    expect(run.stdout).toContain('✔ update-service issued (desired count unchanged)');
    expect(run.stdout).toContain('rollout COMPLETED');
    // Nothing failed, so no diagnostics were printed.
    expect(run.stderr).not.toContain('rollout diagnostics');
    expect(run.awsCalls.some((call) => call.includes('list-tasks'))).toBe(false);
  });

  it('exits non-zero on a FAILED rollout without burning the whole budget', () => {
    const run = runDeploy('failed', {
      // 60s budget: a fail-fast must return in a small fraction of it.
      ECS_STABILIZE_TIMEOUT_SECONDS: '60',
      ECS_STABILIZE_POLL_SECONDS: '1',
    });

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('rollout FAILED');
    expect(run.stderr).toContain('not waiting out the remaining budget');
    expect(run.elapsedMs).toBeLessThan(15_000);
    // The success line must not be printed for a failed roll.
    expect(run.stdout).not.toContain('now on kortix/kortix-web:dev-ec6cbdb7');
  });

  it('exits non-zero after the configured budget and prints the diagnostics a human needs', () => {
    const run = runDeploy('stuck', {
      ECS_STABILIZE_TIMEOUT_SECONDS: '4',
      ECS_STABILIZE_POLL_SECONDS: '1',
    });

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('did not stabilize within 4s');
    expect(run.stderr).toContain('rolloutState=IN_PROGRESS');

    // The budget is honoured, not rounded up to the old fixed 600s waiter.
    // `date +%s` is whole seconds, so the deadline can land up to 1s early.
    expect(run.elapsedMs).toBeGreaterThanOrEqual(3_000);
    expect(run.elapsedMs).toBeLessThan(30_000);

    // Deployment detail: every deployment's counts + rolloutStateReason.
    expect(run.stderr).toContain('status=PRIMARY rolloutState=IN_PROGRESS');
    expect(run.stderr).toContain('rolloutStateReason=ECS deployment ecs-svc/1 in progress.');
    expect(run.stderr).toContain('taskDefinition=arn:aws:ecs:us-west-2:111:task-definition/kortix-dev-web:500');

    // Service events, newest first, with timestamps.
    expect(run.stderr).toContain('2026-09-18T20:04:41+00:00');
    expect(run.stderr).toContain('STUB_EVENT_NEWEST');
    expect(run.stderr).toContain('STUB_EVENT_SECOND');

    // Stopped-task exit reasons: evidence that a task died and why. Their
    // absence proves nothing — see the no-stopped-tasks case below.
    // Both tasks are reported, and only real task ARNs are counted.
    expect(run.stderr).toContain('stopped tasks (newest 2)');
    expect(run.stderr).toContain('STUB_STOPPED_REASON');
    expect(run.stderr).toContain('exitCode=1');
    expect(run.stderr).toContain('STUB_CONTAINER_REASON');
    expect(run.stderr).toContain('STUB_SECOND_STOPPED_REASON');
    // A null exitCode renders as "-", never as "null".
    expect(run.stderr).toContain('exitCode=- reason=STUB_NULL_EXIT_REASON');

    // The awslogs hint, as a copy-pasteable command.
    expect(run.stderr).toContain('/ecs/kortix-dev-web');
    expect(run.stderr).toContain('aws logs tail /ecs/kortix-dev-web');

    // The live-task lastStatus breakdown: the signal that distinguishes a
    // PENDING wedge from a task that died. pendingCount also leads the headline.
    expect(run.stderr).toContain('live tasks by lastStatus (desired RUNNING, newest 2)');
    expect(run.stderr).toMatch(/PENDING=1 PROVISIONING=1|PROVISIONING=1 PENDING=1/);
    expect(run.stderr).toContain('STUB_PENDING_REASON');
    // A container with no reason contributes no line, keeping the output small.
    expect(run.stderr).not.toContain('bbbb2222pending lastStatus=PROVISIONING container=web reason=-');

    // Both task lists are capped, never a full dump.
    const listTasks = run.awsCalls.filter((call) => call.includes('list-tasks'));
    expect(listTasks).toHaveLength(2);
    expect(listTasks.filter((call) => call.includes('--desired-status RUNNING'))).toHaveLength(1);
    expect(listTasks.filter((call) => call.includes('--desired-status STOPPED'))).toHaveLength(1);
    for (const call of listTasks) {
      expect(call).toContain('--max-items 5');
    }
  });

  it('reports no-stopped-tasks as an observation and never concludes the roll is merely slow', () => {
    // The wedge the old wording got backwards: nothing STOPPED, yet the rollout
    // is stuck because every new task is blocked in PENDING on an image pull.
    const run = runDeploy('stuck', {
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
