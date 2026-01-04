// Shared utility for tracking tool numbers (tool1, tool2, etc.) across components
// This ensures consistent tool identification in verbose logging

const toolIdMap = new Map<string, number>();
let toolCounter = 0;

export function getOrAssignToolNumber(toolCallId: string): number {
  if (!toolIdMap.has(toolCallId)) {
    toolCounter += 1;
    toolIdMap.set(toolCallId, toolCounter);
  }
  return toolIdMap.get(toolCallId)!;
}

export function getToolNumber(toolCallId: string): number | undefined {
  return toolIdMap.get(toolCallId);
}

export function clearToolTracking(): void {
  toolIdMap.clear();
  toolCounter = 0;
}
