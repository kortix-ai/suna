import {
  legacyPerProjectWarmImageName,
  parseExactPpwarmImageName,
  perProjectWarmImageName,
  scopedPerProjectWarmImageName,
} from './ppwarm-names';

export interface ProjectImageRollout {
  fastConfigured: boolean;
  fastEnabled: boolean;
  dataPlaneScope: string;
}

export interface ProjectImageReadCandidate {
  name: string;
  format: 'scoped' | 'unscoped' | 'legacy';
}

function fastRoutingEnabled(rollout: ProjectImageRollout): boolean {
  return rollout.fastConfigured && rollout.fastEnabled;
}

export function projectImageWriteName(
  projectId: string,
  tip: string,
  baseSnapshotName: string,
  templateSlug: string,
  rollout: ProjectImageRollout,
): string {
  if (fastRoutingEnabled(rollout)) {
    return scopedPerProjectWarmImageName(
      rollout.dataPlaneScope,
      projectId,
      tip,
      baseSnapshotName,
      templateSlug,
    );
  }
  return perProjectWarmImageName(projectId, tip, baseSnapshotName, templateSlug);
}

/** Ordered compatibility lookup. New writes never invalidate existing caches. */
export function projectImageReadCandidates(
  projectId: string,
  tip: string,
  baseSnapshotName: string,
  templateSlug: string,
  includeLegacy: boolean,
  rollout: ProjectImageRollout,
): ProjectImageReadCandidate[] {
  const candidates: ProjectImageReadCandidate[] = [];
  if (fastRoutingEnabled(rollout)) {
    candidates.push({
      name: scopedPerProjectWarmImageName(
        rollout.dataPlaneScope,
        projectId,
        tip,
        baseSnapshotName,
        templateSlug,
      ),
      format: 'scoped',
    });
  }
  candidates.push({
    name: perProjectWarmImageName(projectId, tip, baseSnapshotName, templateSlug),
    format: 'unscoped',
  });
  if (includeLegacy) {
    candidates.push({
      name: legacyPerProjectWarmImageName(projectId, tip, baseSnapshotName),
      format: 'legacy',
    });
  }
  return candidates;
}

/**
 * Verify that a durable transition's stored image name still represents the
 * supplied project identity. The data-plane segment of a scoped name is taken
 * from the stored name so an in-flight transition survives a scope/flag rollout.
 */
export function projectImageNameMatchesIdentity(
  name: string,
  projectId: string,
  tip: string,
  baseSnapshotName: string,
  templateSlug: string,
  includeLegacy: boolean,
): boolean {
  const parsed = parseExactPpwarmImageName(name);
  if (!parsed) return false;
  if (parsed.format === 'scoped') {
    return (
      name ===
      scopedPerProjectWarmImageName(
        parsed.dataPlaneScope,
        projectId,
        tip,
        baseSnapshotName,
        templateSlug,
      )
    );
  }
  if (parsed.format === 'unscoped') {
    return name === perProjectWarmImageName(projectId, tip, baseSnapshotName, templateSlug);
  }
  return (
    includeLegacy &&
    name === legacyPerProjectWarmImageName(projectId, tip, baseSnapshotName)
  );
}
