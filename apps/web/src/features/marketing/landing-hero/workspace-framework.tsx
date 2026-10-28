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
    <div className="flex w-full flex-col gap-3">
      {/* The two views, named above the board so no label covers the app. */}
      <div className="flex items-center justify-between text-sm font-medium">
        <span className="text-foreground">Workspace</span>
        <span className="text-foreground">Framework</span>
      </div>
      <div className="relative w-full">
        <SessionWindow />
        <div
          className="absolute inset-0"
          style={{ clipPath: `inset(0 0 0 ${split}%)` }}
          aria-hidden
        >
          <FrameworkWindow />
        </div>

        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0"
          style={{ left: `${split}%` }}
        >
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
    </div>
  );
}
