import { sleep } from 'k6';
import { probeHealth, browseEndpoints } from './lib/common.js';
import { makeHandleSummary } from './lib/summary.js';

export const options = {
  scenarios: {
    soak: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 30 },
        { duration: '56m', target: 30 },
        { duration: '2m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    health_errors: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  probeHealth();
  browseEndpoints();
  sleep(1);
}

export const handleSummary = makeHandleSummary('soak');
