import { sleep } from 'k6';
import { probeHealth, browseEndpoints } from './lib/common.js';
import { makeHandleSummary } from './lib/summary.js';

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '20s', target: 500 },
        { duration: '1m', target: 500 },
        { duration: '20s', target: 10 },
        { duration: '1m', target: 10 },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.10'],
    checks: ['rate>0.90'],
  },
};

export default function () {
  probeHealth();
  browseEndpoints();
  sleep(0.3);
}

export const handleSummary = makeHandleSummary('spike');
