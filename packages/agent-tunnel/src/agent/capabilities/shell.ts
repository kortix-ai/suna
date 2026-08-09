/**
 * Shell Capability — handles shell.exec for running commands on the local machine.
 *
 * Security:
 *   - Commands are executed as array args (no shell interpolation)
 *   - First arg (executable) is validated against allowedCommands / blockedCommands
 *   - Working directory is validated against allowedPaths / blockedPaths
 *   - Timeout enforcement
 */

import { spawn } from 'child_process';
import type { Capability, RpcHandler } from './index';
import { validateCommand } from '../security/command-validator';
import { validatePath } from '../security/path-validator';
import type { TunnelConfig } from '../config';
import type { LocalPermission } from '../security/permission-guard';

interface LocalShellScope {
  commands?: string[];
  workingDir?: string;
  maxTimeout?: number;
}

function permissionShellScope(params: Record<string, unknown>): LocalShellScope {
  const permission = params.__permission as LocalPermission | undefined;
  if (permission?.capability !== 'shell') {
    throw new Error('Permission denied: shell permission required');
  }
  return (permission.scope ?? {}) as LocalShellScope;
}

export function createShellCapability(config: TunnelConfig): Capability {
  const methods = new Map<string, RpcHandler>();

  methods.set('shell.exec', async (params) => {
    const command = params.command as string;
    const args = (params.args as string[]) || [];
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
      throw new Error('Command args must be an array of strings');
    }
    const scope = permissionShellScope(params);
    const cwd = (params.cwd as string) || config.workingDir;
    const requestedTimeout =
      params.timeout === undefined ? config.shellTimeout : Number(params.timeout);
    if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
      throw new Error('Command timeout must be a positive number');
    }
    const timeout = Math.min(
      requestedTimeout,
      config.shellMaxTimeout,
      typeof scope.maxTimeout === 'number' ? scope.maxTimeout : config.shellMaxTimeout,
    );

    const scopedCommands = Array.isArray(scope.commands)
      ? scope.commands.filter((value): value is string => typeof value === 'string')
      : [];
    const executable = validateCommand(command, config.allowedCommands, config.blockedCommands);
    if (scopedCommands.length > 0) {
      validateCommand(executable, scopedCommands, []);
    }

    if (cwd) {
      validatePath(cwd, config.allowedPaths, config.blockedPaths);
      if (typeof scope.workingDir === 'string' && scope.workingDir.length > 0) {
        validatePath(cwd, [scope.workingDir], config.blockedPaths);
      }
    }

    const safeEnv: Record<string, string> = { TERM: 'dumb' };
    for (const key of config.shellEnvPassthrough) {
      if (process.env[key]) {
        safeEnv[key] = process.env[key]!;
      }
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(executable, args, {
        cwd,
        shell: false,
        timeout,
        env: safeEnv,
      });

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;

      proc.stdout?.on('data', (data: Buffer) => {
        if (stdout.length >= config.shellMaxOutputSize) {
          stdoutTruncated = true;
          return;
        }
        const chunk = data.toString();
        const remaining = config.shellMaxOutputSize - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        if (stderr.length >= config.shellMaxOutputSize) {
          stderrTruncated = true;
          return;
        }
        const chunk = data.toString();
        const remaining = config.shellMaxOutputSize - stderr.length;
        if (chunk.length > remaining) {
          stderr += chunk.slice(0, remaining);
          stderrTruncated = true;
        } else {
          stderr += chunk;
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Command failed to start: ${err.message}`));
      });

      proc.on('close', (code, signal) => {
        resolve({
          exitCode: code,
          signal,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
        });
      });
    });
  });

  return {
    name: 'shell',
    methods,
  };
}
