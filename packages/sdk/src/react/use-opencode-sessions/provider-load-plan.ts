export function shouldLoadProjectModelPicker(input: {
  projectId: string | null;
  projectModeKnown: boolean;
  projectGatewayEnabled: boolean;
}): boolean {
  return Boolean(
    input.projectId && (!input.projectModeKnown || input.projectGatewayEnabled),
  );
}
