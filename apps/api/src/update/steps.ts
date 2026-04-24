import type { ResolvedEndpoint } from '../platform/providers';
import type { StepResult } from './types';
import { execOnHost } from './exec';
import {
  buildDockerRunCommand,
  buildManagedServiceStartScript,
  isJustAVPSManagedConfig,
  JUSTAVPS_SERVICE_NAME,
  JUSTAVPS_STARTUP_PATCH_HOST,
  type ContainerConfig,
} from './container-config';

export const VERIFY_CONTAINER_MAX_RETRIES = 5;

export function getCurrentImage(endpoint: ResolvedEndpoint, containerName: string): Promise<StepResult> {
  return execOnHost(
    endpoint,
    `docker inspect --format='{{.Config.Image}}' '${containerName}'`,
    10,
  );
}

// ─── Pre-flight checks ──────────────────────────────────────────────────────

/** Verify Docker daemon is running and responsive */
export async function checkDockerDaemon(endpoint: ResolvedEndpoint): Promise<StepResult> {
  const result = await execOnHost(endpoint, 'docker info --format "{{.ServerVersion}}" 2>/dev/null', 10);
  if (result.success && result.stdout?.trim()) {
    return { ...result, stdout: `Docker ${result.stdout.trim()}` };
  }
  return { success: false, stdout: '', stderr: 'Docker daemon is not running or not responsive. Try restarting the machine.', exitCode: -1, durationMs: 0 };
}

/** Check if the machine has enough disk space for the image (~6GB needed) */
export async function checkDiskSpace(endpoint: ResolvedEndpoint): Promise<StepResult> {
  const result = await execOnHost(
    endpoint,
    "df -BG /var/lib/docker 2>/dev/null | awk 'NR==2 {print $4}' | tr -d 'G'",
    10,
  );
  if (result.success) {
    const freeGB = parseInt(result.stdout?.trim() || '0', 10);
    if (freeGB < 6) {
      return { success: false, stdout: '', stderr: `Only ${freeGB}GB free disk space. Need at least 6GB to pull the image. Try pruning old Docker images: docker system prune -af`, exitCode: -1, durationMs: 0 };
    }
    return { success: true, stdout: `${freeGB}GB free`, stderr: '', exitCode: 0, durationMs: 0 };
  }
  // Can't check — proceed anyway
  return { success: true, stdout: 'unknown', stderr: '', exitCode: 0, durationMs: 0 };
}

/** Verify the target image tag exists on Docker Hub before attempting pull */
export async function checkImageExistsOnHub(image: string): Promise<StepResult> {
  try {
    const colonIdx = image.lastIndexOf(':');
    const repo = colonIdx > 0 ? image.slice(0, colonIdx) : image;
    const tag = colonIdx > 0 ? image.slice(colonIdx + 1) : 'latest';
    const url = `https://hub.docker.com/v2/repositories/${repo}/tags/${tag}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      return { success: true, stdout: `${image} exists on Docker Hub`, stderr: '', exitCode: 0, durationMs: 0 };
    }
    if (res.status === 404) {
      return { success: false, stdout: '', stderr: `Image ${image} does not exist on Docker Hub. Verify the version tag is correct.`, exitCode: -1, durationMs: 0 };
    }
    return { success: true, stdout: `Docker Hub returned ${res.status} — proceeding`, stderr: '', exitCode: 0, durationMs: 0 };
  } catch {
    return { success: true, stdout: 'Docker Hub check skipped', stderr: '', exitCode: 0, durationMs: 0 };
  }
}

// ─── Pull image ─────────────────────────────────────────────────────────────

export async function pullImage(endpoint: ResolvedEndpoint, image: string): Promise<StepResult> {
  const startTime = Date.now();

  // 1. Check if image already cached locally
  const exists = await execOnHost(endpoint, `docker image inspect ${image} >/dev/null 2>&1 && echo cached`, 10);
  if (exists.stdout?.trim() === 'cached') {
    return { success: true, stdout: 'cached', stderr: '', exitCode: 0, durationMs: 0 };
  }

  // 2. Clean up ALL stale pull units from any previous attempts
  await execOnHost(
    endpoint,
    'for u in $(systemctl list-units --all --no-legend "kortix-pull-*" | awk "{print \\$1}"); do systemctl stop "$u" 2>/dev/null; systemctl reset-failed "$u" 2>/dev/null; done; true',
    10,
  );

  // 3. Quick prune to free space
  await execOnHost(endpoint, 'docker image prune -f >/dev/null 2>&1 || true', 15);

  // 4. Start pull in background via systemd-run (CF proxy times out on long operations)
  const unitName = `kortix-pull-${Date.now()}`;
  const startPull = await execOnHost(
    endpoint,
    `systemd-run --unit=${unitName} --description="Pull ${image}" -- docker pull ${image} 2>&1`,
    20,
  );

  if (!startPull.success) {
    // systemd-run failed — try direct pull as last resort
    console.warn(`[UPDATE] systemd-run failed (${startPull.stderr}), trying direct pull...`);
    const directPull = await execOnHost(endpoint, `docker pull ${image} 2>&1`, 300);
    if (directPull.success) {
      return { success: true, stdout: 'pulled (direct)', stderr: '', exitCode: 0, durationMs: Date.now() - startTime };
    }
    return {
      success: false,
      stdout: '',
      stderr: `Pull failed to start. systemd-run: ${startPull.stderr}. Direct pull: ${directPull.stderr}`,
      exitCode: -1,
      durationMs: Date.now() - startTime,
    };
  }

  // 5. Smart polling — monitor both image availability AND pull unit health
  const TIMEOUT_MS = 10 * 60 * 1000;
  let lastLogTime = 0;

  while (Date.now() - startTime < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 5000));

    // Check if image appeared
    const check = await execOnHost(endpoint, `docker image inspect ${image} >/dev/null 2>&1 && echo ready`, 10);
    if (check.stdout?.trim() === 'ready') {
      return { success: true, stdout: 'pulled', stderr: '', exitCode: 0, durationMs: Date.now() - startTime };
    }

    // Check pull unit status — detect early failure
    const unitStatus = await execOnHost(endpoint, `systemctl is-active ${unitName} 2>/dev/null || echo dead`, 5);
    const status = unitStatus.stdout?.trim();

    if (status === 'failed' || status === 'dead' || status === 'inactive') {
      const logs = await execOnHost(endpoint, `journalctl -u ${unitName} --no-pager -n 30 2>/dev/null || true`, 10);
      const logOutput = logs.stdout?.trim() || 'No logs available';

      // Diagnose failure
      let diagnosis = 'Docker pull failed.';
      if (logOutput.includes('not found') || logOutput.includes('manifest unknown')) {
        diagnosis = `Image ${image} does not exist on Docker Hub.`;
      } else if (logOutput.includes('no space left')) {
        diagnosis = 'No disk space. Run: docker system prune -af';
      } else if (logOutput.includes('timeout') || logOutput.includes('TLS') || logOutput.includes('network')) {
        diagnosis = 'Network error connecting to Docker Hub.';
      } else if (logOutput.includes('unauthorized') || logOutput.includes('denied')) {
        diagnosis = 'Docker Hub authentication error.';
      }

      return {
        success: false, stdout: '',
        stderr: `${diagnosis}\n\nLogs:\n${logOutput.slice(0, 1000)}`,
        exitCode: -1, durationMs: Date.now() - startTime,
      };
    }

    // Progress logging every 30s
    if (Date.now() - lastLogTime > 30_000) {
      lastLogTime = Date.now();
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[UPDATE] Pull in progress (${elapsed}s, unit: ${status})...`);
    }
  }

  // Timeout — collect diagnostics
  await execOnHost(endpoint, `systemctl stop ${unitName} 2>/dev/null || true`, 5);
  const logs = await execOnHost(endpoint, `journalctl -u ${unitName} --no-pager -n 30 2>/dev/null || true`, 10);
  const diskInfo = await execOnHost(endpoint, "df -h /var/lib/docker 2>/dev/null | tail -1 || true", 5);
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  return {
    success: false, stdout: '',
    stderr: `Pull timed out after ${elapsed}s for ${image}.\nDisk: ${diskInfo.stdout?.trim() || 'unknown'}\nLogs:\n${(logs.stdout?.trim() || 'none').slice(0, 1000)}`,
    exitCode: -1, durationMs: Date.now() - startTime,
  };
}

// ─── Container operations ───────────────────────────────────────────────────

export async function checkpointSqlite(endpoint: ResolvedEndpoint, containerName: string): Promise<StepResult> {
  // The Python fallback is base64-encoded to avoid shell quoting issues —
  // parentheses in glob.glob() / sqlite3.connect() break sh parsing otherwise.
  const pythonFallback = Buffer.from(
    'import sqlite3,glob\nfor db in glob.glob("/workspace/.local/share/opencode/*.db"):\n c=sqlite3.connect(db); c.execute("PRAGMA wal_checkpoint(TRUNCATE)"); c.close()',
  ).toString('base64');

  return execOnHost(
    endpoint,
    `docker exec '${containerName}' sh -c "if command -v kortix-opencode-state >/dev/null 2>&1; then kortix-opencode-state sync --archive pre-update; else echo ${pythonFallback} | base64 -d | python3; fi"`,
    60,
  );
}

export async function ensureContainerRunning(
  endpoint: ResolvedEndpoint,
  config: ContainerConfig,
): Promise<StepResult> {
  const inspect = await execOnHost(
    endpoint,
    `docker inspect --format='{{.State.Status}}' '${config.name}' 2>/dev/null`,
    10,
  );
  if (inspect.success && inspect.stdout.trim().replace(/'/g, '') === 'running') {
    return { success: true, stdout: 'running', stderr: '', exitCode: 0, durationMs: inspect.durationMs };
  }

  const restart = await stopAndStartContainer(endpoint, config);
  if (!restart.success) {
    return restart;
  }

  const verified = await verifyContainer(endpoint, config.image, config.name, 3);
  if (!verified.success) {
    return verified;
  }

  return { success: true, stdout: 'recovered', stderr: '', exitCode: 0, durationMs: restart.durationMs + verified.durationMs };
}

export async function stopAndStartContainer(
  endpoint: ResolvedEndpoint,
  config: ContainerConfig,
): Promise<StepResult> {
  if (isJustAVPSManagedConfig(config)) {
    return restartManagedJustAVPSContainer(endpoint, config);
  }

  const runCommand = buildDockerRunCommand(config);

  // Shell-quote the container name inside the generated bash script
  const sqName = `'${config.name.replace(/'/g, "'\\''")}'`;
  const scriptLines = [
    '#!/bin/bash',
    `systemctl disable --now ${JUSTAVPS_SERVICE_NAME} 2>/dev/null || true`,
    'systemctl disable --now kortix-sandbox 2>/dev/null || true',
    'systemctl disable --now kortix-port-shim 2>/dev/null || true',
    'rm -f /etc/systemd/system/kortix-port-shim.service',
    `docker stop -t 10 ${sqName} 2>/dev/null || true`,
    `docker rm -f ${sqName} 2>/dev/null || true`,
    `for i in $(seq 1 10); do docker inspect ${sqName} >/dev/null 2>&1 || break; sleep 1; done`,
    runCommand,
  ].join('\n');

  const b64 = Buffer.from(scriptLines).toString('base64');
  const unitName = `kortix-update-${Date.now()}`;
  const scriptPath = `/tmp/kortix-update-${Date.now()}.sh`;

  await execOnHost(
    endpoint,
    `echo '${b64}' | base64 -d > ${scriptPath} && chmod +x ${scriptPath}`,
    5,
  );

  const result = await execOnHost(
    endpoint,
    `systemctl reset-failed ${unitName} 2>/dev/null || true; systemd-run --unit=${unitName} --description="Kortix sandbox update" ${scriptPath}`,
    15,
  );

  // The container restart kills the proxy connection, so 502/aborted/timeout is expected
  if (!result.success && (result.stderr.includes('502') || result.stderr.includes('aborted') || result.stderr.includes('timed out'))) {
    return { success: true, stdout: '', stderr: '', exitCode: 0, durationMs: result.durationMs };
  }
  return result;
}

async function restartManagedJustAVPSContainer(
  endpoint: ResolvedEndpoint,
  config: ContainerConfig,
): Promise<StepResult> {
  const startScript = buildManagedServiceStartScript(config);
  const serviceUnit = [
    '[Unit]',
    'Description=Kortix sandbox workload',
    'After=network-online.target docker.service',
    'Requires=docker.service',
    'Wants=network-online.target',
    '[Service]',
    'Type=simple',
    `ExecStartPre=/bin/sh -lc 'systemctl reset-failed docker.service ${JUSTAVPS_SERVICE_NAME}.service >/dev/null 2>&1 || true'`,
    'ExecStartPre=/bin/systemctl start docker.service',
    `ExecStartPre=/bin/sh -lc '/usr/bin/docker rm -f ${config.name.replace(/'/g, "'\\''")} >/dev/null 2>&1 || true'`,
    `ExecStart=/usr/local/bin/${JUSTAVPS_SERVICE_NAME}-start.sh`,
    'Restart=always',
    'RestartSec=3',
    'StartLimitIntervalSec=0',
    'TimeoutStartSec=0',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');

  const payload = Buffer.from(JSON.stringify({ startScript, serviceUnit })).toString('base64');
  const script = [
    '#!/bin/bash',
    'set -euo pipefail',
    `PAYLOAD_B64='${payload}'`,
    'PAYLOAD_JSON="$(mktemp)"',
    'echo "$PAYLOAD_B64" | base64 -d > "$PAYLOAD_JSON"',
    'python3 - "$PAYLOAD_JSON" <<\'PY\'',
    'import json, pathlib, sys',
    'payload = json.loads(pathlib.Path(sys.argv[1]).read_text())',
    'start_path = pathlib.Path("/usr/local/bin/justavps-docker-start.sh")',
    'start_path.write_text(payload["startScript"] + "\\n")',
    'start_path.chmod(0o755)',
    'pathlib.Path("/etc/systemd/system/justavps-docker.service").write_text(payload["serviceUnit"] + "\\n")',
    'PY',
    'rm -f "$PAYLOAD_JSON"',
    `curl -fsSL https://raw.githubusercontent.com/kortix-ai/suna/main/core/startup.sh -o ${JUSTAVPS_STARTUP_PATCH_HOST}`,
    `chmod +x ${JUSTAVPS_STARTUP_PATCH_HOST}`,
    'systemctl daemon-reload',
    'systemctl disable --now kortix-port-shim 2>/dev/null || true',
    'rm -f /etc/systemd/system/kortix-port-shim.service',
    `systemctl enable ${JUSTAVPS_SERVICE_NAME} >/dev/null 2>&1 || true`,
    `docker stop -t 10 '${config.name.replace(/'/g, "'\\''")}' 2>/dev/null || true`,
    `docker rm -f '${config.name.replace(/'/g, "'\\''")}' 2>/dev/null || true`,
    `systemctl restart ${JUSTAVPS_SERVICE_NAME}`,
  ].join('\n');

  const b64 = Buffer.from(script).toString('base64');
  const scriptPath = `/tmp/kortix-managed-restart-${Date.now()}.sh`;
  await execOnHost(
    endpoint,
    `echo '${b64}' | base64 -d > ${scriptPath} && chmod +x ${scriptPath}`,
    5,
  );

  const result = await execOnHost(endpoint, scriptPath, 30);
  if (!result.success && (result.stderr.includes('502') || result.stderr.includes('aborted') || result.stderr.includes('timed out'))) {
    return { success: true, stdout: '', stderr: '', exitCode: 0, durationMs: result.durationMs };
  }
  return result;
}

export async function verifyContainer(
  endpoint: ResolvedEndpoint,
  expectedImage: string,
  containerName: string,
  retries = VERIFY_CONTAINER_MAX_RETRIES,
): Promise<StepResult> {
  let lastObserved = 'container missing';
  for (let i = 0; i < retries; i++) {
    const result = await execOnHost(
      endpoint,
      `docker inspect --format='{{.Config.Image}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.Error}}' '${containerName}'`,
      10,
    );
    if (result.success) {
      const [runningImage = '', state = '', exitCode = '', stateError = ''] = result.stdout
        .trim()
        .replace(/'/g, '')
        .split('|');
      lastObserved = `image=${runningImage || 'unknown'}, state=${state || 'unknown'}, exitCode=${exitCode || 'unknown'}${stateError ? `, error=${stateError}` : ''}`;
      if (runningImage === expectedImage && state === 'running') {
        return result;
      }
    } else if (result.stderr.trim()) {
      lastObserved = result.stderr.trim();
    }
    const delay = Math.min(2000 * Math.pow(1.5, i), 15000);
    await new Promise((r) => setTimeout(r, delay));
  }

  const diagnostics = await collectContainerDiagnostics(endpoint, containerName);
  return {
    success: false,
    stdout: '',
    stderr: `Container not running expected image ${expectedImage} after ${retries} retries. Last observed: ${lastObserved}${diagnostics ? `\n\nDiagnostics:\n${diagnostics}` : ''}`,
    exitCode: -1,
    durationMs: 0,
  };
}

async function collectContainerDiagnostics(endpoint: ResolvedEndpoint, containerName: string): Promise<string> {
  const diagnostics = await execOnHost(
    endpoint,
    [
      `echo 'docker ps:'`,
      `docker ps -a --filter name='^/${containerName}$' --format '{{.Names}}|{{.Image}}|{{.Status}}' 2>/dev/null || true`,
      `echo ''`,
      `echo 'docker inspect:'`,
      `docker inspect --format='{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.Error}}|{{.State.StartedAt}}|{{.State.FinishedAt}}' '${containerName}' 2>/dev/null || true`,
      `echo ''`,
      `echo 'justavps-docker logs:'`,
      `journalctl -u ${JUSTAVPS_SERVICE_NAME} --no-pager -n 30 2>/dev/null || true`,
      `echo ''`,
      `echo 'kortix-sandbox logs:'`,
      `journalctl -u kortix-sandbox --no-pager -n 30 2>/dev/null || true`,
    ].join('; '),
    15,
  );

  return (diagnostics.stdout || diagnostics.stderr || '').trim().slice(0, 2000);
}
