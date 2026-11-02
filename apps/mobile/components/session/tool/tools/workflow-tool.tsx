/** Read-only workflow details. Reuses mobile's disclosure and raw-output surfaces. */
import { TreeStructureIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { BasicTool, partInput, partMetadata, partOutput, ToolOutputFallback } from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';

export function WorkflowTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(call);
  const metadata = partMetadata(call);
  const output = partOutput(call);
  return (
    <BasicTool
      disclosureId={disclosureKey('tool', call.id)}
      icon={TreeStructureIcon}
      trigger={{ title: 'Workflow', subtitle: typeof input.title === 'string' ? input.title : '', args: [] }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {typeof input.code === 'string' && input.code ? <OutputBlock text={input.code} /> : null}
      {Object.keys(metadata).length > 0 ? <OutputBlock text={JSON.stringify(metadata, null, 2)} /> : null}
      {output ? <ToolOutputFallback output={output} toolName="workflow" /> : null}
    </BasicTool>
  );
}
ToolRegistry.register('workflow', WorkflowTool);
