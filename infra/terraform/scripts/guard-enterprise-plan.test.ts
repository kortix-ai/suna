import { describe, expect, test } from 'bun:test';

import { classifyEnterprisePlan } from './guard-enterprise-plan.ts';

describe('enterprise Terraform plan guard', () => {
  test('auto-applies additive and ordinary runtime updates', () => {
    const result = classifyEnterprisePlan({
      resource_changes: [
        { address: 'aws_ecr_repository.runtime', type: 'aws_ecr_repository', change: { actions: ['create'] } },
        { address: 'aws_codebuild_project.updater', type: 'aws_codebuild_project', change: { actions: ['update'] } },
        { address: 'aws_instance.supabase', type: 'aws_instance', change: { actions: ['no-op'] } },
      ],
    });

    expect(result.decision).toBe('auto_apply');
    expect(result.summary).toEqual({ create: 1, update: 1, delete: 0, replace: 0, read: 0, noop: 1 });
  });

  test('blocks deletions and replacements even when another change is safe', () => {
    const result = classifyEnterprisePlan({
      resource_changes: [
        { address: 'aws_s3_bucket.backups', type: 'aws_s3_bucket', change: { actions: ['delete'] } },
        { address: 'aws_instance.supabase', type: 'aws_instance', change: { actions: ['delete', 'create'] } },
        { address: 'aws_ecr_repository.runtime', type: 'aws_ecr_repository', change: { actions: ['create'] } },
      ],
    });

    expect(result.decision).toBe('blocked');
    expect(result.summary.delete).toBe(1);
    expect(result.summary.replace).toBe(1);
    expect(result.reasons).toHaveLength(2);
  });

  test('requires review for IAM, signing roots, EKS access, network, and recovery controls', () => {
    const result = classifyEnterprisePlan({
      resource_changes: [
        { address: 'aws_iam_role.updater', type: 'aws_iam_role', change: { actions: ['update'] } },
        { address: 'aws_kms_key.data', type: 'aws_kms_key', change: { actions: ['update'] } },
        { address: 'aws_eks_access_entry.operator', type: 'aws_eks_access_entry', change: { actions: ['create'] } },
        { address: 'aws_security_group.supabase', type: 'aws_security_group', change: { actions: ['update'] } },
        { address: 'aws_backup_vault.supabase', type: 'aws_backup_vault', change: { actions: ['update'] } },
        {
          address: 'aws_s3_bucket_lifecycle_configuration.backups',
          type: 'aws_s3_bucket_lifecycle_configuration',
          change: { actions: ['update'] },
        },
      ],
    });

    expect(result.decision).toBe('manual_review');
    expect(result.reasons.every((reason) => reason.severity === 'manual_review')).toBe(true);
  });

  test('fails closed on malformed or unknown action sets', () => {
    const result = classifyEnterprisePlan({
      resource_changes: [
        { address: 'terraform_data.mystery', type: 'terraform_data', change: { actions: [] } },
        { address: 'aws_instance.unknown', type: 'aws_instance', change: { actions: ['teleport'] } },
      ],
    });

    expect(result.decision).toBe('blocked');
    expect(result.reasons).toHaveLength(2);
  });
});
