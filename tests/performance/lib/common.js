import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8008/v1').replace(/\/$/, '');

export const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

export const healthLatency = new Trend('health_latency', true);
export const healthErrors = new Rate('health_errors');

export function defaultHeaders() {
  const headers = { Accept: 'application/json' };
  if (AUTH_TOKEN) {
    headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  }
  return headers;
}

export function probeHealth() {
  const res = http.get(`${BASE_URL}/health`, {
    headers: defaultHeaders(),
    tags: { endpoint: 'health' },
  });
  healthLatency.add(res.timings.duration);
  const ok = check(res, {
    'health status is 2xx/3xx': (r) => r.status >= 200 && r.status < 400,
    'health has body': (r) => r.body && r.body.length >= 0,
  });
  healthErrors.add(!ok);
  return res;
}

export function browseEndpoints() {
  const endpoints = (__ENV.ENDPOINTS || '/health').split(',').map((e) => e.trim());
  const requests = endpoints.map((path) => [
    'GET',
    `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`,
    null,
    { headers: defaultHeaders(), tags: { endpoint: path } },
  ]);
  const responses = http.batch(requests);
  for (const res of responses) {
    check(res, {
      'request not 5xx': (r) => r.status < 500,
    });
  }
  return responses;
}
