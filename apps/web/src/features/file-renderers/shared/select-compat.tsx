'use client';

// Vendored extend.ai viewers (e.g. pdf-viewer.tsx) are written against
// extend.ai's own base-ui-powered `Select` (`modal` on the root,
// `alignItemWithTrigger` on the content/popup), which doesn't line up with
// this repo's shadcn/Radix-based `@/components/ui/select`. Radix's
// `Select.Root` has no `modal` concept and shadcn's `SelectContent` has no
// `alignItemWithTrigger` concept — both are already effectively "off" in the
// Radix version, so this shim just accepts (and drops) those two props for
// API parity instead of widening the app-wide select component or pulling
// in `@base-ui/react`.
import * as React from 'react';
import {
  Select as SelectPrimitive,
  SelectContent as SelectContentPrimitive,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export { SelectItem, SelectTrigger, SelectValue };

type SelectCompatProps = React.ComponentProps<typeof SelectPrimitive> & {
  modal?: boolean;
};

export function Select({ modal: _modal, ...props }: SelectCompatProps) {
  return <SelectPrimitive {...props} />;
}

type SelectContentCompatProps = React.ComponentProps<typeof SelectContentPrimitive> & {
  alignItemWithTrigger?: boolean;
};

export function SelectContent({ alignItemWithTrigger: _alignItemWithTrigger, ...props }: SelectContentCompatProps) {
  return <SelectContentPrimitive {...props} />;
}
