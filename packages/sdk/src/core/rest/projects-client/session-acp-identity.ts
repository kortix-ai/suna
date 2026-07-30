import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

type SessionRuntimeHarness = 'claude' | 'codex' | 'opencode' | 'pi';

export interface ProjectSessionAcpIdentity {
  acp_server_id: string;
  runtime_harness: SessionRuntimeHarness;
  acp_session_id: string;
}

export async function persistProjectSessionAcpIdentity(
  projectId: string,
  sessionId: string,
  input: ProjectSessionAcpIdentity,
) {
  return unwrap(
    await backendApi.put<ProjectSessionAcpIdentity>(
      `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/acp-identity`,
      input,
    ),
  );
}
