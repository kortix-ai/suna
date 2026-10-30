import { describe, expect, it } from 'bun:test';
import * as infrastructure from './infrastructure';

describe('infrastructure barrel contract', () => {
  it('keeps the public tool helpers and components available', () => {
    for (const name of [
      'useServicePreview', 'ServicePreviewViewport', 'partStreamingInput',
      'partOutput', 'ToolOutputFallback', 'RawOutputBlock', 'BasicTool',
      'ToolCodeCard', 'ToolMarkdownCard', 'getToolDiagnostics',
      'DiagnosticsDisplay', 'ToolNavigationContext', 'ToolOutcomeContext',
      'partOutcome', 'StructuredOutput',
    ]) {
      expect(infrastructure[name as keyof typeof infrastructure]).toBeDefined();
    }
  });
});
