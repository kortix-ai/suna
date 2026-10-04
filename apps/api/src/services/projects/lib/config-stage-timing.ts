/** Non-identifying stage attribution for the session-config read. */
import { getRequestContext, setContextField } from '../../../lib/request-context';

export type ConfigStage = 'project_access' | 'session_access' | 'sandbox_state' | 'latest_etag' | 'desired_release' | 'runtime_block' | 'config_dir';

export async function timeConfigStage<T>(stage: ConfigStage, fn: () => Promise<T>): Promise<T> {
  const context = getRequestContext();
  if (!context) return fn();
  const start = performance.now();
  // Parallel stages must not clear each other's pending marker.
  const pending = (context.config_pending_stages ?? '').split(',').filter(Boolean);
  setContextField('config_pending_stages', [...pending, stage].join(','));
  try {
    return await fn();
  } finally {
    setContextField(`config_${stage}_ms`, String(Math.round(performance.now() - start)));
    setContextField('config_pending_stages', (context.config_pending_stages ?? '').split(',').filter((name) => name !== stage).join(','));
  }
}
