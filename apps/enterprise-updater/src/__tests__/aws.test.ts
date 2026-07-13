import { describe, expect, test } from 'bun:test';

import { AwsControlPlane } from '../aws.ts';
import type { CommandRunner, RunOptions } from '../process.ts';

class RecordingRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  failure: Error | null = null;

  run(command: string, args: string[], _options?: RunOptions): string {
    this.calls.push({ command, args });
    if (this.failure) throw this.failure;
    return '{}';
  }
}

function control(runner: RecordingRunner): AwsControlPlane {
  return new AwsControlPlane(runner, {
    region: 'us-west-2',
    expectedAccountId: '935064898258',
    stateTable: 'kortix-vpc-demo-release-state',
    instance: 'kortix-vpc-demo',
  });
}

describe('customer updater lease', () => {
  test('atomically refuses to start while a reviewed PITR operation is active', () => {
    const runner = new RecordingRunner();
    control(runner).acquireLease();

    const args = runner.calls[0]?.args ?? [];
    const condition = args[args.indexOf('--condition-expression') + 1];
    const values = JSON.parse(args[args.indexOf('--expression-attribute-values') + 1] ?? '{}');
    expect(condition).toContain('attribute_not_exists(recovery_in_progress) OR recovery_in_progress = :false');
    expect(condition).toContain('attribute_not_exists(lease_expires_at) OR lease_expires_at < :now');
    expect(values[':false']).toEqual({ BOOL: false });
  });

  test('propagates DynamoDB lease contention without beginning reconciliation', () => {
    const runner = new RecordingRunner();
    runner.failure = new Error('ConditionalCheckFailedException');

    expect(() => control(runner).acquireLease()).toThrow('ConditionalCheckFailedException');
    expect(runner.calls).toHaveLength(1);
  });
});
