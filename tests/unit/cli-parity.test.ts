import { describe, expect, it } from 'vitest';
import { computeCliParity, normalize } from '../src/coverage/cli-parity-core';

const routes = [
  { method: 'GET', path: '/v1/projects' },
  { method: 'GET', path: '/health' },
  { method: 'POST', path: '/v1/projects/:id/sessions' },
];

describe('computeCliParity', () => {
  it('accepts pre-existing debt frozen in the baseline (no new unmapped)', () => {
    const r = computeCliParity({
      routes,
      mapped: [],
      exempt: [],
      baselineUnmapped: ['GET /v1/projects', 'GET /health', 'POST /v1/projects/:*/sessions'],
    });
    expect(r.newUnmapped).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it('fails when a brand-new route is neither mapped, exempt, nor in the baseline', () => {
    const r = computeCliParity({ routes, mapped: [], exempt: [], baselineUnmapped: [] });
    expect(r.pass).toBe(false);
    expect(r.newUnmapped).toContain('GET /v1/projects');
  });

  it('passes a new route once it is mapped to a CLI command', () => {
    const r = computeCliParity({
      routes: [{ method: 'GET', path: '/v1/projects' }],
      mapped: [{ method: 'GET', path: '/v1/projects' }],
      exempt: [],
      baselineUnmapped: [],
    });
    expect(r.unmapped).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it('passes a new route once it is exempted', () => {
    const r = computeCliParity({
      routes: [{ method: 'GET', path: '/health' }],
      mapped: [],
      exempt: [{ method: 'GET', path: '/health' }],
      baselineUnmapped: [],
    });
    expect(r.unmapped).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it('normalizes path params so :id and :projectId match', () => {
    const r = computeCliParity({
      routes: [{ method: 'POST', path: '/v1/projects/:id/sessions' }],
      mapped: [{ method: 'POST', path: '/v1/projects/:projectId/sessions' }],
      exempt: [],
      baselineUnmapped: [],
    });
    expect(r.unmapped).toEqual([]);
  });

  it('flags a route that was resolved since the baseline (encourages --update-baseline)', () => {
    const r = computeCliParity({
      routes: [{ method: 'GET', path: '/health' }],
      mapped: [],
      exempt: [{ method: 'GET', path: '/health' }],
      baselineUnmapped: ['GET /health'],
    });
    expect(r.resolvedSinceBaseline).toEqual(['GET /health']);
    expect(r.pass).toBe(true);
  });

  it('update-baseline always passes and reports the full unmapped set to snapshot', () => {
    const r = computeCliParity({
      routes,
      mapped: [],
      exempt: [],
      baselineUnmapped: [],
      updateBaseline: true,
    });
    expect(r.pass).toBe(true);
    expect(r.unmapped.length).toBe(3);
  });
});

describe('normalize', () => {
  it('uppercases the method and collapses params', () => {
    expect(normalize('get', '/v1/projects/:projectId')).toBe('GET /v1/projects/:*');
  });
});
