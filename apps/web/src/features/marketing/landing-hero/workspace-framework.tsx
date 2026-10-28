'use client';

import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { FrameworkWindow } from './framework-window';
import { SessionWindow } from './session-window';

/**
 * One Northwind project, two views, split by a divider the reader drags:
 * the workspace people use on the left, the same project as code on the
 * right. A native range input carries the drag and the arrow keys, so the
 * divider needs no pointer code of its own.
 */
export function WorkspaceFramework() {
  const [split, setSplit] = useState(50);

  return (
    <div className="relative w-full">
      <SessionWindow />
      <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${split}%)` }} aria-hidden>
        <FrameworkWindow />
      </div>

      <span className="bg-foreground text-background pointer-events-none absolute top-3 left-3 rounded-md px-2.5 py-1 text-xs font-medium lg:top-5 lg:left-5">
        Workspace
      </span>
      <span className="bg-foreground text-background pointer-events-none absolute top-3 right-3 rounded-md px-2.5 py-1 text-xs font-medium lg:top-5 lg:right-5">
        Framework
      </span>

      <div aria-hidden className="pointer-events-none absolute inset-y-0" style={{ left: `${split}%` }}>
        <div className="bg-foreground absolute inset-y-0 -left-px w-0.5" />
        <div className="bg-background text-foreground absolute top-1/2 left-0 flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border shadow-md">
          <CaretLeftIcon className="size-3.5" />
          <CaretRightIcon className="size-3.5" />
        </div>
      </div>

      <input
        type="range"
        min={0}
        max={100}
        value={split}
        onChange={(event) => setSplit(Number(event.target.value))}
        aria-label="Drag to compare the workspace with the same project as code"
        className="absolute inset-0 size-full cursor-ew-resize appearance-none opacity-0"
      />
    </div>
  );
}
