import * as React from 'react';

const DialogDepthContext = React.createContext(0);
DialogDepthContext.displayName = 'DialogDepthContext';

export function DialogDepthProvider({
  depth,
  children,
}: {
  depth: number;
  children: React.ReactNode;
}) {
  return (
    <DialogDepthContext.Provider value={depth}>
      {children}
    </DialogDepthContext.Provider>
  );
}

export function useDialogDepth(): number {
  return React.useContext(DialogDepthContext);
}

export function dialogOverlayZ(depth: number): number {
  const level = Math.max(1, depth);
  return 9998 + (level - 1) * 20;
}

export function dialogContentZ(depth: number): number {
  const level = Math.max(1, depth);
  return 9999 + (level - 1) * 20;
}

export function floatingZ(depth: number): number {
  if (depth <= 0) return 10001;
  return dialogContentZ(depth) + 2;
}
