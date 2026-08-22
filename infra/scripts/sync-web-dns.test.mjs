import { describe, expect, test } from 'bun:test';
import { syncWebDns, webDnsRecord } from './sync-web-dns.mjs';

describe('webDnsRecord', () => {
  test('renders the canonical Dev host and isolated ECS hosts elsewhere', () => {
    const targets = {
      dev: 'kortix-dev-web-alb-123.us-west-2.elb.amazonaws.com',
      staging: 'kortix-staging-web-alb-123.us-west-2.elb.amazonaws.com',
      prod: 'kortix-prod-web-alb-123.eu-west-2.elb.amazonaws.com',
    };
    const expectedHosts = {
      dev: 'dev.kortix.com',
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

  test('selects canonical Dev only and preserves isolated staging and prod hosts', () => {
    const target = 'kortix-dev-web-alb-123.us-west-2.elb.amazonaws.com';
    expect(webDnsRecord('dev', target).name).toBe('dev.kortix.com');
    expect(webDnsRecord('staging', target).name).toBe('staging-fe-ecs.kortix.com');
    expect(webDnsRecord('prod', target).name).toBe('prod-fe-ecs.kortix.com');
  });

  test('converts the existing canonical Vercel A record to the ECS CNAME in place', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.CLOUDFLARE_API_TOKEN;
    const requests = [];
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (!options.method) {
        return Response.json({
          success: true,
          result: [
            {
              id: 'canonical-record',
              type: 'A',
              name: 'dev.kortix.com',
              content: '76.76.21.21',
              proxied: true,
            },
          ],
        });
      }
      return Response.json({
        success: true,
        result: {
          id: 'canonical-record',
          type: 'CNAME',
          name: 'dev.kortix.com',
          content: 'kortix-dev-web-alb-123.us-west-2.elb.amazonaws.com',
          proxied: true,
        },
      });
    };

    try {
      const result = await syncWebDns('dev', 'kortix-dev-web-alb-123.us-west-2.elb.amazonaws.com');
      expect(result.action).toBe('updated');
      expect(requests).toHaveLength(2);
      expect(requests[0].url).toContain('name=dev.kortix.com');
      expect(requests[0].url).not.toContain('type=');
      expect(requests[1].url).toContain('/dns_records/canonical-record');
      expect(requests[1].options.method).toBe('PUT');
      expect(JSON.parse(requests[1].options.body)).toMatchObject({
        type: 'CNAME',
        name: 'dev.kortix.com',
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) Reflect.deleteProperty(process.env, 'CLOUDFLARE_API_TOKEN');
      else process.env.CLOUDFLARE_API_TOKEN = originalToken;
    }
  });
});
