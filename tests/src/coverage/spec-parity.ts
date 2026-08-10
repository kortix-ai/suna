const SPEC_FLOW_ID = /^`([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)`(?:\s+|$)/;

export interface FlowIdParity {
  specificationIds: string[];
  registeredIds: string[];
  missingSpecifications: string[];
  missingFlows: string[];
  duplicateSpecifications: string[];
}

export function parseSpecificationFlowIds(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.match(SPEC_FLOW_ID)?.[1] ?? null)
    .filter((id): id is string => id !== null);
}

export function compareFlowIds(
  specificationIds: string[],
  registeredIds: string[],
): FlowIdParity {
  const counts = new Map<string, number>();
  for (const id of specificationIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const specificationSet = new Set(specificationIds);
  const registeredSet = new Set(registeredIds);
  const sort = (values: Iterable<string>) =>
    [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return {
    specificationIds: sort(specificationSet),
    registeredIds: sort(registeredSet),
    missingSpecifications: sort([...registeredSet].filter((id) => !specificationSet.has(id))),
    missingFlows: sort([...specificationSet].filter((id) => !registeredSet.has(id))),
    duplicateSpecifications: sort(
      [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id),
    ),
  };
}
