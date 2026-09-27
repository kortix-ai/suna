// Unit tests for best-effort deployment-region detection.
//
// docs/specs/turn-latency.md §1's own baseline turned out to be dominated by
// geography, not code: dev runs the API in us-west-2 against a database in
// us-east-2 (~45-85x prod's colocated latency on the SAME query). A benchmark
// that does not say where the two halves live is unreadable — this is what
// `/health` surfaces so `pnpm test -- --latency` can print the topology
// instead of silently measuring a network problem as if it were a code path.
import { describe, expect, test } from 'bun:test';
import { apiRegion, databaseRegion } from './deployment-region';

describe('apiRegion', () => {
  test('reads AWS_REGION first', () => {
    expect(apiRegion({ AWS_REGION: 'us-west-2', AWS_DEFAULT_REGION: 'us-east-1' })).toBe(
      'us-west-2',
    );
  });

  test('falls back to AWS_DEFAULT_REGION', () => {
    expect(apiRegion({ AWS_DEFAULT_REGION: 'eu-west-2' })).toBe('eu-west-2');
  });

  test('returns null off ECS/Fargate (no region env at all) instead of a misleading guess', () => {
    expect(apiRegion({})).toBeNull();
  });

  test('treats a blank value as absent', () => {
    expect(apiRegion({ AWS_REGION: '  ', AWS_DEFAULT_REGION: 'ap-south-1' })).toBe('ap-south-1');
  });
});

describe('databaseRegion', () => {
  test('extracts the region from a standard RDS instance endpoint', () => {
    expect(databaseRegion('postgres://user:pass@mydb.abc123xyz.us-east-2.rds.amazonaws.com:5432/kortix')).toBe(
      'us-east-2',
    );
  });

  test('extracts the region from an Aurora cluster endpoint', () => {
    expect(
      databaseRegion(
        'postgres://user:pass@my-cluster.cluster-abc123.eu-west-2.rds.amazonaws.com/kortix',
      ),
    ).toBe('eu-west-2');
  });

  test('never leaks the host or credentials — only the matched region string', () => {
    const url = 'postgres://sekrit_user:sekrit_pass@my-cluster.cluster-abc123.us-west-2.rds.amazonaws.com/kortix';
    const region = databaseRegion(url);
    expect(region).toBe('us-west-2');
    expect(region).not.toContain('sekrit');
    expect(region).not.toContain('my-cluster');
  });

  test('returns null for a non-RDS host (local Supabase, a self-host Postgres) instead of guessing', () => {
    expect(databaseRegion('postgres://postgres:postgres@127.0.0.1:54322/postgres')).toBeNull();
    expect(databaseRegion('postgres://user:pass@db.example.com:5432/kortix')).toBeNull();
  });

  test('is case-insensitive on the region segment', () => {
    expect(databaseRegion('postgres://u:p@h.US-EAST-2.rds.amazonaws.com/db')).toBe('us-east-2');
  });
});
