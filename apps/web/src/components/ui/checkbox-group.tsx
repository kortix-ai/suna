'use client';

import * as React from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

type CheckboxGroupContextValue = {
  value: Set<string>;
  toggle: (itemValue: string, checked: boolean) => void;
  disabled?: boolean;
  name?: string;
};

const CheckboxGroupContext = React.createContext<CheckboxGroupContextValue | null>(null);

function useCheckboxGroupContext() {
  const ctx = React.useContext(CheckboxGroupContext);
  if (!ctx) {
    throw new Error('CheckboxGroupItem must be used within CheckboxGroup');
  }
  return ctx;
}

type CheckboxGroupProps = Omit<React.ComponentProps<'div'>, 'defaultValue' | 'onChange'> & {
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
  disabled?: boolean;
  name?: string;
};

function CheckboxGroup({
  className,
  value,
  defaultValue,
  onValueChange,
  disabled,
  name,
  ...props
}: CheckboxGroupProps) {
  const [internalValue, setInternalValue] = React.useState<string[]>(defaultValue ?? []);
  const isControlled = value !== undefined;
  const selected = React.useMemo(
    () => new Set(isControlled ? value : internalValue),
    [isControlled, value, internalValue],
  );

  const toggle = React.useCallback(
    (itemValue: string, checked: boolean) => {
      const current = isControlled ? value! : internalValue;
      const next = checked
        ? current.includes(itemValue)
          ? current
          : [...current, itemValue]
        : current.filter((entry) => entry !== itemValue);

      if (!isControlled) {
        setInternalValue(next);
      }
      onValueChange?.(next);
    },
    [isControlled, value, internalValue, onValueChange],
  );

  return (
    <CheckboxGroupContext.Provider value={{ value: selected, toggle, disabled, name }}>
      <div
        data-slot="checkbox-group"
        role="group"
        className={cn('grid gap-1', className)}
        {...props}
      />
    </CheckboxGroupContext.Provider>
  );
}

type CheckboxGroupItemProps = {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
};

function CheckboxGroupItem({
  value: itemValue,
  label,
  disabled: itemDisabled,
  id,
  className,
}: CheckboxGroupItemProps) {
  const { value, toggle, disabled: groupDisabled, name } = useCheckboxGroupContext();
  const generatedId = React.useId();
  const itemId = id ?? generatedId;
  const checked = value.has(itemValue);
  const disabled = groupDisabled || itemDisabled;

  return (
    <Checkbox
      id={itemId}
      name={name}
      label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(next) => toggle(itemValue, next === true)}
      className={className}
    />
  );
}

export { CheckboxGroup, CheckboxGroupItem };
export type { CheckboxGroupProps, CheckboxGroupItemProps };
