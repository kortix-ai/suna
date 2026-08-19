'use client';

import * as React from 'react';
import * as ResizablePrimitive from 'react-resizable-panels';

import { cn } from '@/lib/utils';

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      data-slot="resizable-panel-group"
      className={cn('flex h-full w-full data-[panel-group-direction=vertical]:flex-col', className)}
      {...props}
    />
  );
}

const ResizablePanel = React.forwardRef<
  // `React.ElementRef<typeof ResizablePrimitive.Panel>` resolves to `never`
  // under @types/react 19.2: it infers the ref type via
  // `ComponentPropsWithRef<T> extends RefAttributes<infer Method> ? Method :
  // never`, and react-resizable-panels' own compiled `.d.ts` independently
  // instantiates the ref-callback type, so the `extends` check fails. Use
  // the library's own exported handle type directly instead.
  ResizablePrimitive.ImperativePanelHandle,
  React.ComponentPropsWithoutRef<typeof ResizablePrimitive.Panel>
>((props, ref) => {
  return <ResizablePrimitive.Panel ref={ref} data-slot="resizable-panel" {...props} />;
});

ResizablePanel.displayName = 'ResizablePanel';

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      data-slot="resizable-handle"
      className={cn(
        'focus-visible:ring-ring relative flex cursor-col-resize items-center justify-center focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:cursor-row-resize [&[data-panel-group-direction=vertical]>div]:rotate-90',
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="group z-10 flex cursor-col-resize items-center justify-center">
          <span className="bg-muted-foreground/40 group-hover:bg-muted-foreground/70 h-[15px] w-[3px] rounded-full transition-colors" />
        </div>
      )}
    </ResizablePrimitive.PanelResizeHandle>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
