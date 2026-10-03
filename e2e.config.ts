import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';
import { chatgpt } from 'e2e/oauth/chatgpt';
import { assertAgenticListenerOwnership } from './tests/src/core/agentic-ownership';
import { resolveLocalTopology } from './tests/src/core/local-stack';

const topology = resolveLocalTopology(process.cwd());
assertAgenticListenerOwnership(topology);

export default {
  workers: 1,
  retries: 0,
  assertionTimeout: 30_000,
  cleanupTimeout: 120_000,
  trace: 'retain-on-failure',
  reporters: ['list', 'markdown'],
  agents: {
    default: {
      model: chatgpt('gpt-6-luna'),
      system: 'You are a thorough QA agent. Verify every outcome.',
    },
  },
  targets: [
    {
      engine: web(),
      app: {
        url: `http://localhost:${topology.marker?.ports.web ?? 3000}`,
        command: {
          executable: 'pnpm',
          args: topology.worktreeName
            ? ['worktree', 'start', topology.worktreeName, '--billing']
            : ['dev'],
          startupTimeout: 600_000,
          reuseExisting: true,
          log: '.e2e/logs/app.log',
        },
      },
    },
  ],
} satisfies E2EConfig;
