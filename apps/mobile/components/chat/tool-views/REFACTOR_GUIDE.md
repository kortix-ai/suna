# Tool Views - Current Implementation

## Overview
All tool views use the structured `toolCall` and `toolResult` props from metadata.

## Current Pattern

### `_utils.ts` Files:
```typescript
import type { ToolCallData, ToolResultData } from '../types';

export function extractToolData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ToolData {
  // Extract from toolCall.arguments
  const args = toolCall.arguments || {};
  
  // Extract from toolResult.output
  let output: any = {};
  if (toolResult?.output) {
    if (typeof toolResult.output === 'object' && toolResult.output !== null) {
      output = toolResult.output;
    } else if (typeof toolResult.output === 'string') {
      try {
        output = JSON.parse(toolResult.output);
      } catch (e) {
        // Not JSON, ignore
      }
    }
  }
  
  return {
    // Extract from args and output
    // ...
    actualIsSuccess: toolResult?.success !== undefined ? toolResult.success : isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
```

### Component Files:
```typescript
import { extractToolData } from './_utils';

export function ToolView({ 
  toolCall, 
  toolResult, 
  isSuccess = true,
  toolTimestamp,
  assistantTimestamp 
}: ToolViewProps) {
  if (!toolCall) {
    return null;
  }

  const extractedData = extractToolData(toolCall, toolResult, isSuccess, toolTimestamp, assistantTimestamp);
  // ... component logic
}
```

## Key Points

1. **Structured Props**: Use `toolCall.arguments` and `toolResult.output` directly
2. **No Legacy Parsing**: All legacy parsing code has been removed
3. **Type Safety**: Use `ToolCallData` and `ToolResultData` types from `../types`
4. **Defensive Checks**: Always check if `toolCall` exists before using it
