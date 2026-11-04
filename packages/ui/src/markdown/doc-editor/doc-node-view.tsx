'use client';

import { WarningCircleIcon } from '@phosphor-icons/react';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useEffect, useRef, type ComponentType } from 'react';

import { ErrorBoundary } from '../../primitives/error-boundary';

/** What a node view shows when it cannot render: an inert block, the rest of the doc unaffected. */
function NodeViewFailed({ node, reset }: { node: unknown; reset: () => void }) {
  // The node changed (a fix arrived): try the view again.
  const first = useRef(node);
  useEffect(() => {
    if (node !== first.current) reset();
  }, [node, reset]);
  return (
    <NodeViewWrapper
      as="div"
      contentEditable={false}
      data-node-error=""
      className="border-border text-muted-foreground my-3 flex items-center rounded-md border border-dashed px-3 py-2"
    >
      <WarningCircleIcon className="size-4" aria-hidden />
    </NodeViewWrapper>
  );
}

/**
 * A node view that cannot take down the pane: a render error in one node
 * (an attribute a writer set to something the view cannot show) leaves an
 * inert placeholder for that node and is reported. Every React node view of
 * the doc editor goes through this.
 */
export function safeNodeView<P extends ReactNodeViewProps>(View: ComponentType<P>): ComponentType<P> {
  function SafeNodeView(props: P) {
    return (
      <ErrorBoundary fallback={({ reset }) => <NodeViewFailed node={props.node} reset={reset} />}>
        <View {...props} />
      </ErrorBoundary>
    );
  }
  SafeNodeView.displayName = `Safe(${View.displayName ?? View.name})`;
  return SafeNodeView;
}
