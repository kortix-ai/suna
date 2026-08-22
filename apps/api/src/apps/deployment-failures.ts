import { classifySnapshotError } from '../snapshots/error-classify';

type AppDeploymentFailureDisposition = {
  permanent: boolean;
  code: string;
};

/** Separate deterministic user/runtime build errors from transient provider failures. */
export function appDeploymentFailureDisposition(message: string): AppDeploymentFailureDisposition {
  const category = classifySnapshotError(message);
  switch (category) {
    case 'dockerfile':
      return { permanent: true, code: 'dockerfile_build_failed' };
    case 'runtime':
      return { permanent: true, code: 'runtime_artifact_missing' };
    case 'provider':
      return { permanent: false, code: 'provider_error' };
    case 'quota':
      return { permanent: false, code: 'quota' };
    case 'timeout':
      return { permanent: false, code: 'timeout' };
    case 'tunnel':
      return { permanent: false, code: 'tunnel_unreachable' };
    case 'layer':
      return { permanent: false, code: 'runtime_layer_failed' };
    case 'git':
      return { permanent: true, code: 'source_access_failed' };
    case 'unknown':
      return { permanent: false, code: 'deployment_failed' };
  }
}
