// Stable identity for this API process. HOSTNAME is the pod/container name in
// managed deployments; startedAt + pid make it unique across restarts where a
// name can be reused.
export const API_STARTED_AT = new Date().toISOString();
export const API_INSTANCE = process.env.HOSTNAME || 'unknown';
export const API_INSTANCE_ID = `${API_INSTANCE}:${process.pid}:${API_STARTED_AT}`;
