/**
 * Goal evaluation health.
 *
 * npm: import { createKortix } from '@kortix/sdk';
 */
import { createKortix } from '../src/index';

const kortix = createKortix({
  backendUrl: process.env.KORTIX_API_URL ?? 'https://api.kortix.com/v1',
  getToken: async () => process.env.KORTIX_TOKEN ?? '',
});
const projectId = process.env.KORTIX_PROJECT_ID ?? '';
const project = kortix.project(projectId);
const pushed = await project.goals.push('reduce-api-latency');
await project.goals.observations.record('reduce-api-latency', {
  evaluation_id: pushed.evaluation_id,
  metric: 'api_p95_ms',
  value: 184,
  source: 'prometheus:api-p95',
});
const { health } = await project.goals.health('reduce-api-latency');
console.log(health.desired_status, health.health_status, health.metrics);
