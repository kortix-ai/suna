import { sleep } from 'k6';
import { probeHealth, browseEndpoints } from './lib/common.js';
import { makeHandleSummary } from './lib/summary.js';

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 50 },
        { duration: '3m', target: 100 },
        { duration: '3m', target: 200 },
        { duration: '2m', target: 300 },
        { duration: '3m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1500'],
    http_req_failed: ['rate<0.05'],
    checks: ['rate>0.95'],
  },
};

export default function () {
  probeHealth();
  browseEndpoints();
  sleep(0.5);
}

export const handleSummary = makeHandleSummary('stress');
