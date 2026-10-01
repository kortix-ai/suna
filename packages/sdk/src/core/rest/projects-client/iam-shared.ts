import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** Background IAM reads do not raise a global toast for capability-denied access. */
export function iamGet<T>(path: string) {
  return backendApi.get<T>(path, { showErrors: false });
}

/** Keep the historical IAM empty-response message when using the shared unwrap. */
export function iamUnwrap<T>(response: { data?: T; success: boolean; error?: Error }) {
  return unwrap(response, 'Unexpected empty response');
}
