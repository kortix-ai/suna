import { describe, expect, test } from 'bun:test';
import { webDnsRecord } from './sync-web-dns.mjs';

describe('webDnsRecord', () => {
  test('renders only the isolated ECS hostname for each environment', () => {
    const targets = {
      dev: 'kortix-dev-web-alb-123.us-west-2.elb.amazonaws.com',
      staging: 'kortix-staging-web-alb-123.us-west-2.elb.amazonaws.com',
      prod: 'kortix-prod-web-alb-123.eu-west-2.elb.amazonaws.com',
    };
    const expectedHosts = {
      dev: 'dev-fe-ecs.kortix.com',
      staging: 'staging-fe-ecs.kortix.com',
      prod: 'prod-fe-ecs.kortix.com',
    };

    for (const environment of ['dev', 'staging', 'prod']) {
      expect(webDnsRecord(environment, targets[environment])).toMatchObject({
        name: expectedHosts[environment],
        content: targets[environment],
        proxied: true,
      });
    }
  });

  test('rejects unknown environments and non-ALB targets', () => {
    expect(() => webDnsRecord('preview', 'example.com')).toThrow(
      'environment must be dev, staging, or prod',
    );
    expect(() => webDnsRecord('dev', 'example.com')).toThrow('target must be an AWS ELB hostname');
  });

  test('can never select a canonical Vercel hostname', () => {
    const target = 'kortix-dev-web-alb-123.us-west-2.elb.amazonaws.com';
    for (const environment of ['dev', 'staging', 'prod']) {
      expect(webDnsRecord(environment, target).name).toContain('-fe-ecs.kortix.com');
    }
  });
});
