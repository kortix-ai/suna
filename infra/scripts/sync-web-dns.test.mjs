import { describe, expect, test } from 'bun:test';
import { webDnsRecord } from './sync-web-dns.mjs';

describe('webDnsRecord', () => {
  test('renders the Dev origin and canonical records', () => {
    const target = 'kortix-dev-web-alb-123.us-west-2.elb.amazonaws.com';
    expect(webDnsRecord('dev', 'origin', target)).toMatchObject({
      name: 'dev-web-ecs-fargate.kortix.com',
      content: target,
      proxied: true,
    });
    expect(webDnsRecord('dev', 'canonical', target)).toMatchObject({
      name: 'dev.kortix.com',
      content: target,
      proxied: true,
    });
  });

  test('rejects unapproved environments and non-ALB targets', () => {
    expect(() => webDnsRecord('staging', 'origin', 'example.com')).toThrow(
      'only the Dev DNS cutover is enabled',
    );
    expect(() => webDnsRecord('dev', 'origin', 'example.com')).toThrow(
      'target must be an AWS ELB hostname',
    );
  });
});
