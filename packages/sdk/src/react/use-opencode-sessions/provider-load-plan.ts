export function shouldLoadProjectModelPicker(input: {
  workspaceId: string | null;
  projectModeKnown: boolean;
  projectGatewayEnabled: boolean;
}): boolean {
  return Boolean(
    input.workspaceId && (!input.projectModeKnown || input.projectGatewayEnabled),
  );
}
