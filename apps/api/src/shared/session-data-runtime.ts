/** Select the box that owns files, PTYs, and user-exposed ports. */
export function selectSessionDataRuntime(input: {
  workerExternalId: string | null;
  workerStatus: string | null;
  environmentExists: boolean;
  environmentExternalId: string | null;
  environmentStatus: string | null;
}): { externalId: string | null; status: string | null } {
  if (input.environmentExists) {
    return {
      externalId: input.environmentExternalId,
      status: input.environmentStatus,
    };
  }
  return { externalId: input.workerExternalId, status: input.workerStatus };
}
