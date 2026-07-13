import { describe, expect, test } from 'bun:test';
import { dirname, join, normalize } from 'node:path/posix';

import {
  enterpriseTerraformAssets,
  LOCAL_STATE_BACKEND,
  REMOTE_STATE_BACKEND,
} from '../enterprise-assets.ts';

describe('embedded enterprise Terraform graph', () => {
  test('contains every transitive local module referenced by a bundled root or module', () => {
    const paths = Object.keys(enterpriseTerraformAssets);
    const missing: string[] = [];

    for (const [path, content] of Object.entries(enterpriseTerraformAssets)) {
      for (const match of content.matchAll(/^\s*source\s*=\s*"(\.[^"]+)"/gm)) {
        const target = normalize(join(dirname(path), match[1]));
        if (!paths.some((candidate) => candidate.startsWith(`${target}/`))) {
          missing.push(`${path} -> ${match[1]} (${target})`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test('does not bundle Terraform runtime state or provider binaries', () => {
    const paths = Object.keys(enterpriseTerraformAssets);
    expect(paths.some((path) => path.includes('/.terraform/'))).toBe(false);
    expect(paths.some((path) => path.endsWith('.tfstate'))).toBe(false);
    expect(paths.some((path) => path.includes('terraform-provider-'))).toBe(false);
  });

  test('ships explicit local-bootstrap and customer-S3 backend modes', () => {
    expect(LOCAL_STATE_BACKEND).toContain('backend "local"');
    expect(LOCAL_STATE_BACKEND).toContain('terraform.bootstrap.tfstate');
    expect(REMOTE_STATE_BACKEND).toContain('backend "s3"');
    expect(REMOTE_STATE_BACKEND).not.toContain('bucket');
  });

  test('embeds the ALB controller policy as text for the compiled CLI', () => {
    const policy = enterpriseTerraformAssets['modules/eks/platform/files/alb-controller-policy.json'];
    expect(typeof policy).toBe('string');
    expect(JSON.parse(policy)).toMatchObject({ Version: '2012-10-17' });
  });
});
