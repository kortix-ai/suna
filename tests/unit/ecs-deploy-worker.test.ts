import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const script = resolve(root, 'infra/scripts/ecs-deploy.sh');

/**
 * The scheduled-job worker (<prefix>-worker) and the API's KORTIX_PROCESS_ROLE.
 * These cases drive the REAL infra/scripts/ecs-deploy.sh with a stubbed `aws`
 * on PATH (no credentials exist here). The stub answers from documents the
 * case passes in the environment, logs every call, and keeps a copy of the
 * task definition the script registers. `date` and `sleep` are bash functions
 * on one fake clock file, so a rollout budget costs no real time.
 */
const PREFIX = 'kortix-dev-use2';
const IMAGE = 'kortix/kortix-api:dev-new';
const API_TD = `arn:aws:ecs:us-east-2:111:task-definition/${PREFIX}:41`;
const API_TD_NEW = `arn:aws:ecs:us-east-2:111:task-definition/${PREFIX}:42`;
const WORKER_TD = `arn:aws:ecs:us-east-2:111:task-definition/${PREFIX}-worker:7`;
const WORKER_TD_NEW = `arn:aws:ecs:us-east-2:111:task-definition/${PREFIX}-worker:8`;

const AWS_STUB = String.raw`#!/usr/bin/env bash
# String.raw still interpolates JS placeholders, so this stub uses bare $VARs
# and no bash parameter expansion with braces (the API_TD-style constants are
# the test's own values, interpolated on purpose).
set -o pipefail
printf '%s\n' "$*" >>"$STUB_DIR/calls.log"
arg() { local want="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { printf '%s' "$2"; return; }; shift; done; }
SVC="$(arg --services "$@")"; [ -n "$SVC" ] || SVC="$(arg --service "$@")"
QUERY="$(arg --query "$@")"; OUTPUT="$(arg --output "$@")"; TD="$(arg --task-definition "$@")"
P="${PREFIX}"
worker_exists() { [ "$STUB_WORKER_EXISTS" = 1 ]; }

worker_definition() { # $1 = arn, $2 = image, $3 = cpu
  cat <<JSON
{"taskDefinitionArn":"$1","family":"$P-worker","revision":7,"status":"ACTIVE","cpu":"$3","memory":"4096",
"executionRoleArn":"arn:aws:iam::111:role/$P-exec","taskRoleArn":"arn:aws:iam::111:role/$P-task",
"containerDefinitions":[{"name":"worker","image":"$2","essential":true,
"command":["bun","run","src/worker.ts"],
"healthCheck":{"command":["CMD","bun","-e","fetch()"],"interval":30,"timeout":5,"retries":3,"startPeriod":120},
"environment":[{"name":"STALE_TERRAFORM_ONLY","value":"from-the-first-revision"},{"name":"PORT","value":"8008"},
  {"name":"KORTIX_WORKER_ENV_FROM","value":"$STUB_WORKER_ENV_FROM"}],
"secrets":[{"name":"KORTIX_ENV_JSON","valueFrom":"arn:old"}],
"logConfiguration":{"logDriver":"awslogs","options":{"awslogs-group":"/ecs/$P","awslogs-region":"us-east-2","awslogs-stream-prefix":"worker"}}}]}
JSON
}

case "$1 $2" in
  "secretsmanager describe-secret") printf 'arn:aws:secretsmanager:us-east-2:111:secret:kortix-dev-env-AbCdEf' ;;
  "secretsmanager get-secret-value") printf '{"SECRET_ONLY":"blob-value"}' ;;
  "ecs describe-services")
    case "$SVC|$QUERY|$OUTPUT" in
      "$P-worker|services[0].status|text") if worker_exists; then printf 'ACTIVE'; else printf 'None'; fi ;;
      "$P|services[0].status|text") printf 'ACTIVE' ;;
      "$P|services[0].taskDefinition|text") printf '%s' "${API_TD}" ;;
      "$P-worker|services[0].taskDefinition|text") printf '%s' "${WORKER_TD}" ;;
      "$P-worker|services[0].[status,desiredCount]|text")
        if worker_exists; then printf 'ACTIVE\t%s\n' "$STUB_WORKER_DESIRED"; else printf 'None\n'; fi ;;
      *"|table") printf 'stub table\n' ;;
      "$P||json") printf '%s' "$STUB_API_SERVICE_JSON" ;;
      "$P-worker||json") printf '%s' "$STUB_WORKER_SERVICE_JSON" ;;
      *) echo "stub aws: unhandled call: $*" >&2; exit 64 ;;
    esac ;;
  "ecs describe-task-definition")
    case "$TD" in
      "${API_TD}"|"$P")
        cat <<JSON
{"taskDefinitionArn":"${API_TD}","family":"$P","revision":41,"status":"ACTIVE","cpu":"1024","memory":"4096",
"containerDefinitions":[{"name":"api","image":"kortix/kortix-api:dev-old",
"environment":[
  {"name":"KEEP_API","value":"from-the-api-revision"},
  {"name":"ONLY_FROM_AN_EARLIER_OVERRIDE","value":"api-only"},
  {"name":"KORTIX_PLATINUM_US_REGION","value":"us-west"},
  {"name":"KORTIX_PROCESS_ROLE","value":"$STUB_API_RUNNING_ROLE"},
  {"name":"KORTIX_VERSION","value":"0.0.1-dev.old"},
  {"name":"KORTIX_COMMIT","value":"old-commit"},
  {"name":"PORT","value":"8008"}],
"secrets":[{"name":"KORTIX_ENV_JSON","valueFrom":"arn:old"}]}]}
JSON
        ;;
      "$P-worker") worker_definition "${WORKER_TD}" "$STUB_WORKER_IMAGE" "$STUB_WORKER_FAMILY_CPU" ;;
      *"$P-worker:"*) worker_definition "$TD" "$STUB_WORKER_IMAGE" 1024 ;;
      *) echo "stub aws: unhandled call: $*" >&2; exit 64 ;;
    esac ;;
  "ecs register-task-definition")
    file="$(arg --cli-input-json "$@" | sed 's#^file://##')"
    cp "$file" "$STUB_DIR/registered.json"
    if [ "$(jq -r .family "$file")" = "$P-worker" ]; then printf '%s' "${WORKER_TD_NEW}"; else printf '%s' "${API_TD_NEW}"; fi ;;
  "ecs update-service") printf '{"service":{"status":"ACTIVE"}}' ;;
  "ecs list-tasks")
    if [ "$(arg --desired-status "$@")" = RUNNING ] && [ "$(arg --service-name "$@")" = "$P-worker" ]; then
      printf '%s' "$STUB_WORKER_TASK_ARNS"
    else
      printf '[]'
    fi ;;
  "ecs describe-tasks") printf '%s' "$STUB_WORKER_TASKS_JSON" ;;
  *) echo "stub aws: unhandled call: $*" >&2; exit 64 ;;
esac
`;

const FAKE_TIME = {
  'BASH_FUNC_date%%':
    '() { if [ "$*" = "+%s" ]; then local t; read -r t <"$FAKE_CLOCK" || :; echo "$t"; else command date "$@"; fi; }',
  'BASH_FUNC_sleep%%': '() { local t; read -r t <"$FAKE_CLOCK" || :; echo $(( t + $1 )) >"$FAKE_CLOCK"; }',
};

type Doc = Record<string, unknown>;

const deployment = (taskDefinition: string, rolloutState: string, running = 1, desired = 1, pending = 0) => ({
  status: 'PRIMARY',
  rolloutState,
  rolloutStateReason: `stub ${rolloutState}`,
  taskDefinition,
  desiredCount: desired,
  runningCount: running,
  pendingCount: pending,
});
const service = (deployments: Doc[], counts: { running: number; desired: number; pending?: number }) => ({
  services: [
    {
      status: 'ACTIVE',
      runningCount: counts.running,
      desiredCount: counts.desired,
      pendingCount: counts.pending ?? 0,
      deployments,
      events: [],
    },
  ],
});
const workerTask = (taskDefinition: string, lastStatus: string, healthStatus: string, desiredStatus = 'RUNNING') => ({
  taskArn: `arn:aws:ecs:us-east-2:111:task/${PREFIX}/${lastStatus.toLowerCase()}-${healthStatus.toLowerCase()}`,
  taskDefinitionArn: taskDefinition,
  desiredStatus,
  lastStatus,
  healthStatus,
});

/** A worker that runs IMAGE on WORKER_TD with one HEALTHY task: the API may go `web`. */
const HEALTHY_WORKER = {
  services: service([deployment(WORKER_TD, 'COMPLETED')], { running: 1, desired: 1 }),
  image: IMAGE,
  tasks: { tasks: [workerTask(WORKER_TD, 'RUNNING', 'HEALTHY')] },
};

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  registered: Doc | null;
  elapsedS: number;
}

function deploy(args: string[], stub: Record<string, string> = {}, env: Record<string, string> = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-worker-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'aws'), AWS_STUB);
    chmodSync(join(bin, 'aws'), 0o755);
    const clock = join(dir, 'clock');
    writeFileSync(clock, '1000000');
    writeFileSync(join(dir, 'calls.log'), '');
    const run = spawnSync('bash', [script, 'dev-use2', IMAGE, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...FAKE_TIME,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_CLOCK: clock,
        STUB_DIR: dir,
        PREFIX,
        API_TD,
        API_TD_NEW,
        WORKER_TD,
        WORKER_TD_NEW,
        STUB_WORKER_EXISTS: '1',
        STUB_WORKER_DESIRED: '1',
        STUB_WORKER_IMAGE: HEALTHY_WORKER.image,
        // A revision ecs-deploy.sh registered carries the API task definition
        // it copied its environment from. '' = Terraform's first revision.
        STUB_WORKER_ENV_FROM: API_TD,
        STUB_WORKER_FAMILY_CPU: '1024',
        STUB_API_RUNNING_ROLE: 'all',
        STUB_WORKER_SERVICE_JSON: JSON.stringify(HEALTHY_WORKER.services),
        STUB_WORKER_TASK_ARNS: JSON.stringify(HEALTHY_WORKER.tasks.tasks.map((task) => task.taskArn)),
        STUB_WORKER_TASKS_JSON: JSON.stringify(HEALTHY_WORKER.tasks),
        STUB_API_SERVICE_JSON: JSON.stringify(
          service([deployment(API_TD_NEW, 'COMPLETED', 2, 2)], { running: 2, desired: 2 }),
        ),
        KORTIX_ECS_ENV_OVERRIDES: '{"KORTIX_PLATINUM_US_REGION":"us-east","ADDED":"by-override"}',
        ECS_STABILIZE_TIMEOUT_SECONDS: '60',
        ECS_STABILIZE_POLL_SECONDS: '15',
        GITHUB_ACTIONS: '',
        ...stub,
        ...env,
      },
    });
    const registeredPath = join(dir, 'registered.json');
    return {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      calls: readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean),
      registered: existsSync(registeredPath) ? JSON.parse(readFileSync(registeredPath, 'utf8')) : null,
      elapsedS: Number(readFileSync(clock, 'utf8')) - 1_000_000,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const containerEnv = (registered: Doc | null, name: string) => {
  const containers = (registered?.containerDefinitions ?? []) as Array<{ name: string; environment: Array<{ name: string; value: string }> }>;
  return containers.find((container) => container.name === name)?.environment ?? [];
};
const roleIn = (registered: Doc | null) =>
  containerEnv(registered, 'api').find((entry) => entry.name === 'KORTIX_PROCESS_ROLE')?.value;
const scaleDownCalls = (calls: string[]) =>
  calls.filter((call) => call.startsWith('ecs update-service') && call.includes(`--service ${PREFIX}-worker`) && call.includes('--desired-count 0'));

function decide(services: unknown, definition: unknown, tasks: unknown, image = IMAGE) {
  const text = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));
  const run = spawnSync(
    'bash',
    ['-c', 'source infra/scripts/ecs-deploy.sh; decide_api_process_role "$1" "$2" "$3" "$4"', 'bash', text(services), text(definition), text(tasks), image],
    { cwd: root, encoding: 'utf8', env: { ...process.env, KORTIX_ECS_DEPLOY_LIB: '1' } },
  );
  expect(run.status).toBe(0);
  const [role, reason] = run.stdout.replace(/\n$/, '').split('\t');
  return { role, reason };
}

const workerDefinition = (arn: string, image: string, envFrom: string | null = API_TD) => ({
  taskDefinitionArn: arn,
  family: `${PREFIX}-worker`,
  containerDefinitions: [
    {
      name: 'worker',
      image,
      environment: [
        { name: 'PORT', value: '8008' },
        ...(envFrom === null ? [] : [{ name: 'KORTIX_WORKER_ENV_FROM', value: envFrom }]),
      ],
    },
  ],
});
const NOT_REGISTERED = `the worker runs a revision ecs-deploy.sh did not register (${WORKER_TD} has no KORTIX_WORKER_ENV_FROM)`;

describe('decide_api_process_role (pure)', () => {
  const healthy = () => ({
    services: structuredClone(HEALTHY_WORKER.services) as ReturnType<typeof service>,
    definition: workerDefinition(WORKER_TD, IMAGE) as Doc,
    tasks: structuredClone(HEALTHY_WORKER.tasks) as { tasks: Doc[] },
  });

  it('answers web when the worker is ACTIVE, COMPLETED, on the same image, with a HEALTHY task', () => {
    const { services, definition, tasks } = healthy();
    expect(decide(services, definition, tasks)).toEqual({
      role: 'web',
      reason: `the worker runs ${IMAGE} on ${WORKER_TD} with 1 HEALTHY task(s)`,
    });
    // describe-task-definition without --query wraps the document; both shapes count.
    expect(decide(services, { taskDefinition: definition }, tasks).role).toBe('web');
  });

  const failing: Array<[string, (input: ReturnType<typeof healthy>) => void, string | RegExp]> = [
    ['the worker service does not exist', (input) => { input.services.services = []; }, 'the worker service does not exist'],
    ['the worker service is DRAINING', (input) => { input.services.services[0].status = 'DRAINING'; }, 'the worker service is DRAINING, not ACTIVE'],
    ['no PRIMARY deployment', (input) => { input.services.services[0].deployments = []; }, 'the worker service has no PRIMARY deployment'],
    ['the PRIMARY rollout is IN_PROGRESS', (input) => { (input.services.services[0].deployments[0] as Doc).rolloutState = 'IN_PROGRESS'; }, 'the worker PRIMARY deployment is IN_PROGRESS, not COMPLETED'],
    ['the PRIMARY rollout FAILED', (input) => { (input.services.services[0].deployments[0] as Doc).rolloutState = 'FAILED'; }, 'the worker PRIMARY deployment is FAILED, not COMPLETED'],
    ['the task definition read failed', (input) => { input.definition = {}; }, `the worker PRIMARY task definition ${WORKER_TD} could not be read`],
    ['the task definition is another revision', (input) => { input.definition = workerDefinition(WORKER_TD_NEW, IMAGE); }, `the worker PRIMARY task definition ${WORKER_TD} could not be read`],
    ['the worker runs an older image', (input) => { input.definition = workerDefinition(WORKER_TD, 'kortix/kortix-api:dev-old'); }, `the worker PRIMARY task definition ${WORKER_TD} runs kortix/kortix-api:dev-old, not ${IMAGE}`],
    ['the revision has no worker container', (input) => { input.definition = { taskDefinitionArn: WORKER_TD, containerDefinitions: [{ name: 'api', image: IMAGE }] }; }, NOT_REGISTERED],
    // A failed first roll that the circuit breaker rolled back to Terraform's
    // revision: in prod it runs the release image (var.api_image) with
    // Terraform's environment. It must never make the API `web`.
    ['the worker runs Terraform\'s first revision on the release image', (input) => { input.definition = workerDefinition(WORKER_TD, IMAGE, null); }, NOT_REGISTERED],
    ['the stamp is empty', (input) => { input.definition = workerDefinition(WORKER_TD, IMAGE, ''); }, NOT_REGISTERED],
    ['the stamp sits on another container', (input) => {
      input.definition = {
        taskDefinitionArn: WORKER_TD,
        containerDefinitions: [
          { name: 'worker', image: IMAGE, environment: [] },
          { name: 'sidecar', image: IMAGE, environment: [{ name: 'KORTIX_WORKER_ENV_FROM', value: API_TD }] },
        ],
      };
    }, NOT_REGISTERED],
    ['no task', (input) => { input.tasks = { tasks: [] }; }, `no worker task of ${WORKER_TD} is RUNNING and HEALTHY (lastStatus/healthStatus: no task)`],
    ['the task is not HEALTHY yet', (input) => { input.tasks = { tasks: [workerTask(WORKER_TD, 'RUNNING', 'UNKNOWN')] }; }, /RUNNING\/UNKNOWN/],
    ['the task is still PENDING', (input) => { input.tasks = { tasks: [workerTask(WORKER_TD, 'PENDING', 'UNKNOWN')] }; }, /PENDING\/UNKNOWN/],
    ['the HEALTHY task is on an older revision', (input) => { input.tasks = { tasks: [workerTask(WORKER_TD_NEW, 'RUNNING', 'HEALTHY')] }; }, /no task/],
    ['the HEALTHY task is being stopped', (input) => { input.tasks = { tasks: [workerTask(WORKER_TD, 'RUNNING', 'HEALTHY', 'STOPPED')] }; }, /no task/],
  ];
  for (const [name, mutate, reason] of failing) {
    it(`answers all when ${name}`, () => {
      const input = healthy();
      mutate(input);
      const verdict = decide(input.services, input.definition, input.tasks);
      expect(verdict.role).toBe('all');
      if (typeof reason === 'string') expect(verdict.reason).toBe(reason);
      else expect(verdict.reason).toMatch(reason);
    });
  }

  it('answers all for empty or malformed AWS output, never an error', () => {
    expect(decide('', '', '').role).toBe('all');
    expect(decide('not json', '[1]', '"x"').role).toBe('all');
    expect(decide({ services: ['x'] }, null, null).role).toBe('all');
    const { services, definition, tasks } = healthy();
    expect(decide(services, definition, tasks, '').role).toBe('all');
  });
});

describe('ecs-deploy.sh --service worker', () => {
  it('copies the API environment, applies the overrides, drops KORTIX_PROCESS_ROLE, and starts one task', () => {
    const run = deploy(['--service', 'worker', '--version', '0.0.2-dev.new'], {
      STUB_WORKER_IMAGE: 'kortix/kortix-api:dev-old',
      // Terraform resized the family after the running revision was registered.
      STUB_WORKER_FAMILY_CPU: '2048',
      STUB_API_RUNNING_ROLE: 'web',
      STUB_WORKER_SERVICE_JSON: JSON.stringify(service([deployment(WORKER_TD_NEW, 'COMPLETED')], { running: 1, desired: 1 })),
    });

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`cluster=${PREFIX} service=${PREFIX}-worker container=worker`);
    expect(run.stdout).toContain(`▶ environment copied from ${API_TD} (container api)`);
    expect(run.stdout).toContain('✔ update-service issued (new revision, then desired count 1)');
    expect(run.stdout).toContain('rollout COMPLETED');

    // The worker revision keeps its own container shape (command, health
    // check, log prefix) and family, takes the new image, and the
    // Terraform-owned size from the family's latest revision.
    const registered = run.registered!;
    expect(registered.family).toBe(`${PREFIX}-worker`);
    expect(registered.cpu).toBe('2048');
    const container = (registered.containerDefinitions as Array<Doc>)[0];
    expect(container.name).toBe('worker');
    expect(container.image).toBe(IMAGE);
    expect(container.command).toEqual(['bun', 'run', 'src/worker.ts']);
    expect(container.healthCheck).toMatchObject({ interval: 30, retries: 3, startPeriod: 120 });
    expect(container.secrets).toEqual([
      { name: 'KORTIX_ENV_JSON', valueFrom: 'arn:aws:secretsmanager:us-east-2:111:secret:kortix-dev-env-AbCdEf' },
    ]);
    expect(containerEnv(registered, 'worker')).toEqual([
      // The API revision's values, never the worker's own first revision.
      { name: 'KEEP_API', value: 'from-the-api-revision' },
      { name: 'ONLY_FROM_AN_EARLIER_OVERRIDE', value: 'api-only' },
      { name: 'PORT', value: '8008' },
      // This run's overrides and the gateway target, sorted by name.
      { name: 'ADDED', value: 'by-override' },
      { name: 'KORTIX_PLATINUM_US_REGION', value: 'us-east' },
      { name: 'LLM_GATEWAY_PROXY_TARGET', value: 'https://gateway-dev-use2.kortix.com' },
      // The mark of a revision this script registered: the API task
      // definition the environment came from.
      { name: 'KORTIX_WORKER_ENV_FROM', value: API_TD },
      { name: 'KORTIX_VERSION', value: '0.0.2-dev.new' },
    ]);

    // Two calls, revision first: one call with both made ECS start a task of
    // the old revision on a worker at 0 (dev, 2026-11-01).
    const updates = run.calls.filter((call) => call.startsWith('ecs update-service'));
    expect(updates).toHaveLength(2);
    expect(updates[0]).toContain(`--service ${PREFIX}-worker`);
    expect(updates[0]).toContain(`--task-definition ${WORKER_TD_NEW}`);
    expect(updates[0]).toContain('--force-new-deployment');
    expect(updates[0]).not.toContain('--desired-count');
    expect(updates[1]).toContain(`--service ${PREFIX}-worker`);
    expect(updates[1]).toContain('--desired-count 1');
    expect(updates[1]).not.toContain('--task-definition');
  });

  it('from 0 tasks with only the new deployment left, raises the count at once', () => {
    const run = deploy(['--service', 'worker'], {
      STUB_WORKER_SERVICE_JSON: JSON.stringify(service([deployment(WORKER_TD_NEW, 'COMPLETED')], { running: 0, desired: 0 })),
    }, { ECS_STABILIZE_POLL_SECONDS: '5' });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('title=Worker roll');
    const updates = run.calls.filter((call) => call.startsWith('ecs update-service'));
    expect(updates.map((call) => call.includes('--desired-count 1'))).toEqual([false, true]);
  });

  it('from 0 tasks, waits for the earlier deployment to leave, then warns and raises the count when it stays', () => {
    // Prod, 2026-11-01: with the earlier deployment still listed, raising the
    // count started a task of the earlier revision.
    const run = deploy(['--service', 'worker'], {
      STUB_WORKER_SERVICE_JSON: JSON.stringify(
        service([deployment(WORKER_TD_NEW, 'COMPLETED'), { ...deployment(WORKER_TD, 'COMPLETED'), status: 'ACTIVE' }], { running: 0, desired: 0 }),
      ),
    }, { ECS_STABILIZE_POLL_SECONDS: '5', ECS_WORKER_SWITCH_WAIT_SECONDS: '20' });

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.stdout).toContain('::warning title=Worker roll::an earlier worker deployment still exists after 20s');
    const rollCalls = run.calls.filter((call) => call.startsWith('ecs update-service') || call.startsWith('ecs describe-services'));
    const first = rollCalls.findIndex((call) => call.includes(`--task-definition ${WORKER_TD_NEW}`));
    const scale = rollCalls.findIndex((call) => call.includes('--desired-count 1'));
    // At least the 4 polls of the 20 s budget sit between the revision call and the count call.
    expect(rollCalls.slice(first + 1, scale).filter((call) => call.startsWith('ecs describe-services')).length).toBeGreaterThanOrEqual(4);
  });

  it('removes KORTIX_PROCESS_ROLE and stamps its own KORTIX_WORKER_ENV_FROM whatever the overrides say', () => {
    const run = deploy(['--service', 'worker'], {
      STUB_WORKER_SERVICE_JSON: JSON.stringify(service([deployment(WORKER_TD_NEW, 'COMPLETED')], { running: 1, desired: 1 })),
    }, { KORTIX_ECS_ENV_OVERRIDES: '{"KORTIX_PROCESS_ROLE":"web","KORTIX_WORKER_ENV_FROM":"forged"}' });

    expect(run.status).toBe(0);
    const environment = containerEnv(run.registered, 'worker');
    expect(environment.map((entry) => entry.name)).not.toContain('KORTIX_PROCESS_ROLE');
    expect(environment.filter((entry) => entry.name === 'KORTIX_WORKER_ENV_FROM')).toEqual([
      { name: 'KORTIX_WORKER_ENV_FROM', value: API_TD },
    ]);
  });

  it('waits stable whatever --wait-for says: a serving new task with the old one still up is not done', () => {
    // The new worker task runs, the old one has not stopped (service running 2,
    // desired 1). `serving` would return here; the worker must keep waiting
    // because the old task still holds the leader lease.
    const draining = service([deployment(WORKER_TD_NEW, 'IN_PROGRESS', 1, 1)], { running: 2, desired: 1 });
    const run = deploy(['--service', 'worker', '--wait-for', 'serving'], {
      STUB_WORKER_SERVICE_JSON: JSON.stringify(draining),
      STUB_WORKER_TASK_ARNS: JSON.stringify([`arn:aws:ecs:us-east-2:111:task/${PREFIX}/new`]),
      STUB_WORKER_TASKS_JSON: JSON.stringify({ tasks: [workerTask(WORKER_TD_NEW, 'RUNNING', 'HEALTHY')] }),
    }, { ECS_STABILIZE_TIMEOUT_SECONDS: '30', ECS_STABILIZE_POLL_SECONDS: '15' });

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.stdout).toContain('--wait-for serving ignored: the worker always waits stable');
    expect(run.stdout).not.toContain('rollout SERVING');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('did not stabilize within 30s');
    expect(run.elapsedS).toBe(30);
    // The diagnostics name the worker's log streams.
    expect(run.stderr).toContain(`stream=worker/worker/<task-id>`);
  });

  it('skips, exit 0, while Terraform has not created the worker service', () => {
    const run = deploy(['--service', 'worker'], { STUB_WORKER_EXISTS: '0' });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`ECS service ${PREFIX}/${PREFIX}-worker not ACTIVE`);
    expect(run.calls.some((call) => call.startsWith('ecs register-task-definition'))).toBe(false);
  });
});

describe('ecs-deploy.sh --service api: KORTIX_PROCESS_ROLE and the worker scale-down', () => {
  it('sets web when the worker is healthy on this image, and never scales the worker', () => {
    const run = deploy(['--version', '0.0.2-dev.new', '--wait-for', 'serving']);

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`▶ KORTIX_PROCESS_ROLE=web (the worker runs ${IMAGE} on ${WORKER_TD} with 1 HEALTHY task(s))`);
    // The running revision said `all`; the decision wins.
    expect(roleIn(run.registered)).toBe('web');
    expect(run.stderr).not.toContain('::warning');
    expect(scaleDownCalls(run.calls)).toEqual([]);
  });

  it('falls back to all with a warning, and scales the worker to 0 only after the API rollout completed', () => {
    const run = deploy(['--version', '0.0.2-dev.new'], {
      STUB_WORKER_IMAGE: 'kortix/kortix-api:dev-old',
      STUB_API_RUNNING_ROLE: 'web',
    });

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.status).toBe(0);
    expect(roleIn(run.registered)).toBe('all');
    expect(run.stderr).toContain(
      `::warning title=API process role::KORTIX_PROCESS_ROLE=all: the worker PRIMARY task definition ${WORKER_TD} runs kortix/kortix-api:dev-old, not ${IMAGE}.`,
    );
    expect(run.stderr).toContain('::warning title=Worker scaled to 0::the API rolled with KORTIX_PROCESS_ROLE=all');
    expect(run.stderr).toContain('scheduled jobs run on the API tasks until the next successful worker roll');

    // Order: the API roll, the rollout wait that saw it COMPLETED, then the scale-down.
    const apiUpdate = run.calls.findIndex((call) => call.startsWith('ecs update-service') && call.includes(`--service ${PREFIX} `));
    const apiWait = run.calls.findIndex((call, index) => index > apiUpdate && call === `ecs describe-services --region us-east-2 --cluster ${PREFIX} --services ${PREFIX} --output json`);
    const scaleDowns = scaleDownCalls(run.calls);
    expect(apiUpdate).toBeGreaterThan(-1);
    expect(apiWait).toBeGreaterThan(apiUpdate);
    expect(scaleDowns).toHaveLength(1);
    expect(run.calls.indexOf(scaleDowns[0])).toBeGreaterThan(apiWait);
  });

  it('falls back to all when the healthy worker runs a revision ecs-deploy.sh did not register', () => {
    // The circuit breaker rolled a failed first worker roll back to
    // Terraform's revision: same image, HEALTHY, but no KORTIX_WORKER_ENV_FROM.
    const run = deploy([], { STUB_WORKER_ENV_FROM: '' });

    expect(run.stderr).not.toContain('unhandled call');
    expect(run.status).toBe(0);
    expect(roleIn(run.registered)).toBe('all');
    expect(run.stdout).toContain(`▶ KORTIX_PROCESS_ROLE=all (${NOT_REGISTERED})`);
    expect(run.stderr).toContain('::warning title=API process role::');
    expect(scaleDownCalls(run.calls)).toHaveLength(1);
  });

  it('--process-role all forces all and the scale-down even when the worker is healthy', () => {
    const run = deploy(['--process-role', 'all']);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('▶ KORTIX_PROCESS_ROLE=all (forced by --process-role all)');
    expect(roleIn(run.registered)).toBe('all');
    // Forced: the worker state is not even read.
    expect(run.calls.some((call) => call.startsWith('ecs list-tasks') && call.includes(`${PREFIX}-worker`))).toBe(false);
    expect(scaleDownCalls(run.calls)).toHaveLength(1);
  });

  it('does not scale the worker down when the API rollout fails', () => {
    const run = deploy([], {
      STUB_WORKER_IMAGE: 'kortix/kortix-api:dev-old',
      STUB_API_SERVICE_JSON: JSON.stringify(service([deployment(API_TD_NEW, 'FAILED', 0, 2)], { running: 0, desired: 2 })),
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('rollout FAILED');
    expect(roleIn(run.registered)).toBe('all');
    expect(scaleDownCalls(run.calls)).toEqual([]);
    expect(run.stderr).not.toContain('Worker scaled to 0');
  });

  it('issues no scale-down when the worker is already at 0 or does not exist', () => {
    const atZero = deploy(['--process-role', 'all'], { STUB_WORKER_DESIRED: '0' });
    expect(atZero.status).toBe(0);
    expect(atZero.stdout).toContain(`worker ${PREFIX}-worker already has desired count 0`);
    expect(scaleDownCalls(atZero.calls)).toEqual([]);
    expect(atZero.stderr).not.toContain('Worker scaled to 0');

    const missing = deploy([], { STUB_WORKER_EXISTS: '0', STUB_WORKER_SERVICE_JSON: '{"services":[],"failures":[{"reason":"MISSING"}]}' });
    expect(missing.status).toBe(0);
    expect(roleIn(missing.registered)).toBe('all');
    expect(missing.stdout).toContain('▶ KORTIX_PROCESS_ROLE=all (the worker service does not exist)');
    expect(scaleDownCalls(missing.calls)).toEqual([]);
  });

  it('a dry run prints the role and annotates, registers and scales nothing', () => {
    const run = deploy(['--dry-run'], { STUB_WORKER_IMAGE: 'kortix/kortix-api:dev-old' });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('▶ KORTIX_PROCESS_ROLE=all (the worker PRIMARY task definition');
    expect(run.stdout).toContain('"name": "KORTIX_PROCESS_ROLE"');
    expect(run.stderr).not.toContain('::warning');
    expect(run.calls.some((call) => call.startsWith('ecs register-task-definition') || call.startsWith('ecs update-service'))).toBe(false);
  });

  it('accepts only auto and all, and only for the API, before touching AWS', () => {
    for (const [args, message] of [
      [['--process-role', 'web'], "--process-role must be auto or all (got: 'web')"],
      [['--process-role', ''], "--process-role must be auto or all (got: '')"],
      [['--service', 'worker', '--process-role', 'all'], '--process-role applies to --service api only (got --service worker)'],
      [['--service', 'gateway', '--process-role', 'all'], '--process-role applies to --service api only (got --service gateway)'],
    ] as const) {
      const run = deploy([...args]);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain(message);
      expect(run.calls).toEqual([]);
    }
  });
});

describe('deploy workflows roll the worker before the API', () => {
  const read = (name: string) => readFileSync(resolve(root, '.github/workflows', name), 'utf8');
  const between = (text: string, start: string, end: string) => {
    const from = text.indexOf(start);
    expect(from, start).toBeGreaterThan(-1);
    const to = text.indexOf(end, from + start.length);
    expect(to, end).toBeGreaterThan(from);
    return text.slice(from, to);
  };
  /** The step that contains `marker`, from its `- name:` line to the next step. */
  const stepOf = (job: string, marker: string) => {
    const at = job.indexOf(marker);
    expect(at, marker).toBeGreaterThan(-1);
    const start = job.lastIndexOf('\n      - ', at);
    const next = job.indexOf('\n      - ', at);
    return job.slice(start, next < 0 ? undefined : next);
  };
  const expectWorkerStep = (job: string, workerRoll: string, apiRoll: string) => {
    const worker = job.indexOf(workerRoll);
    const api = job.indexOf(apiRoll);
    expect(worker, workerRoll).toBeGreaterThan(-1);
    expect(api, apiRoll).toBeGreaterThan(worker);
    const step = stepOf(job, workerRoll);
    // A failed worker roll never blocks the API roll, and the run says so.
    expect(step).toContain('id: worker');
    expect(step).toContain('continue-on-error: true');
    expect(step).toMatch(/timeout-minutes: \d+/);
    const report = between(job, step, apiRoll);
    expect(report).toContain("if: steps.worker.outcome == 'failure'");
    expect(report).toContain('::error title=Worker deploy::');
  };

  it('dev: after the release gate, before the API roll, same image and version', () => {
    const job = between(read('deploy-dev.yml'), '  deploy-api-ecs:', '  deploy-apps-router:');
    const workerRoll =
      'bash infra/scripts/ecs-deploy.sh dev-use2 "${{ needs.build-api.outputs.image }}" --service worker --version "${{ needs.detect-changes.outputs.version }}"';
    const apiRoll =
      'bash infra/scripts/ecs-deploy.sh dev-use2 "${{ needs.build-api.outputs.image }}" --version "${{ needs.detect-changes.outputs.version }}" --wait-for serving';
    expect(job.indexOf('--dry-run')).toBeLessThan(job.indexOf(workerRoll));
    expectWorkerStep(job, workerRoll, apiRoll);
  });

  it('staging: before the API roll, same image and version', () => {
    const job = between(read('deploy-staging.yml'), '  deploy-ecs:', '  wire-cloudflare:');
    expectWorkerStep(
      job,
      'bash infra/scripts/ecs-deploy.sh staging-euw2 "kortix/kortix-api:staging-${SHA8}" --service worker --version "${VERSION}"',
      'bash infra/scripts/ecs-deploy.sh staging-euw2 "kortix/kortix-api:staging-${SHA8}" --version "${VERSION}"',
    );
  });

  it('prod: before the API roll, same image and version, behind the migration gate', () => {
    const job = between(read('deploy-prod.yml'), '  deploy-ecs:', '  deploy-api-router:');
    expectWorkerStep(
      job,
      'bash infra/scripts/ecs-deploy.sh prod "kortix/kortix-api:${VERSION}" --service worker --version "${VERSION}" --database-migrated',
      'bash infra/scripts/ecs-deploy.sh prod "kortix/kortix-api:${VERSION}" --version "${VERSION}" --database-migrated',
    );
  });

  it('rollback: rolls only the API, with --process-role all, and never the worker', () => {
    const workflow = read('rollback-prod.yml');
    const code = workflow
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    // A rollback starts at once and stops a bad worker: no worker roll to wait
    // for, and the API roll scales the worker to 0 once it is stable.
    expect(code).not.toContain('--service worker');
    expect(code).not.toContain('roll_worker');
    // Comments stripped: the step explains the flag in a comment of its own.
    const apiStep = stepOf(code, '"kortix/kortix-api:${TARGET}"');
    expect(apiStep).toMatch(/"kortix\/kortix-api:\$\{TARGET\}" \\\n(?:\s+--[a-z-]+(?: "[^"]+")? \\\n)*\s+--process-role all\n/);
    expect(apiStep).toContain('--database-migrated');
    // The API is the first ECS roll of the rollback.
    const firstRoll = code.indexOf('bash infra/scripts/ecs-deploy.sh');
    expect(code.indexOf('"kortix/kortix-api:${TARGET}"')).toBeGreaterThan(firstRoll);
    expect(code.slice(firstRoll, code.indexOf('"kortix/kortix-api:${TARGET}"'))).not.toContain('kortix/kortix-');
  });
});
