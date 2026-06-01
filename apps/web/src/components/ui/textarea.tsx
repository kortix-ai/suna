'use client';
import { cn } from '@/lib/utils';
import * as React from 'react';
import { useImperativeHandle } from 'react';

interface UseAutosizeTextAreaProps {
  textAreaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  minHeight?: number;
  maxHeight?: number;
  triggerAutoSize: string;
}

export const useAutosizeTextArea = ({
  textAreaRef,
  triggerAutoSize,
  maxHeight = Number.MAX_SAFE_INTEGER,
  minHeight = 0,
}: UseAutosizeTextAreaProps) => {
  const [init, setInit] = React.useState(true);
  const [currentHeight, setCurrentHeight] = React.useState(minHeight);
  const previousContentRef = React.useRef(triggerAutoSize);
  const resizeTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  React.useEffect(() => {
    const offsetBorder = 6;
    const textAreaElement = textAreaRef.current;
    if (!textAreaElement) return;

    if (init) {
      textAreaElement.style.minHeight = `${minHeight + offsetBorder}px`;
      if (maxHeight > minHeight) {
        textAreaElement.style.maxHeight = `${maxHeight}px`;
      }
      setInit(false);
    }

    if (resizeTimeoutRef.current) {
      clearTimeout(resizeTimeoutRef.current);
    }

    resizeTimeoutRef.current = setTimeout(() => {
      const contentLengthChanged =
        Math.abs(previousContentRef.current.length - triggerAutoSize.length) > 5;
      const contentIsEmpty = triggerAutoSize.trim() === '';

      if (!contentLengthChanged && !contentIsEmpty && !init) {
        return;
      }

      const scrollTop = textAreaElement.scrollTop;

      textAreaElement.style.height = `${minHeight + offsetBorder}px`;

      const isEmpty = triggerAutoSize.trim() === '';
      const scrollHeight = textAreaElement.scrollHeight;

      let newHeight: number;

      if (isEmpty) {
        newHeight = minHeight + offsetBorder;
      } else if (scrollHeight > maxHeight) {
        newHeight = maxHeight;
      } else {
        newHeight = scrollHeight + offsetBorder;
      }

      if (Math.abs(newHeight - currentHeight) > 10) {
        textAreaElement.style.height = `${newHeight}px`;
        setCurrentHeight(newHeight);
      } else {
        textAreaElement.style.height = `${currentHeight}px`;
      }

      textAreaElement.scrollTop = scrollTop;

      previousContentRef.current = triggerAutoSize;
    }, 100);

    return () => {
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
    };
  }, [textAreaRef.current, triggerAutoSize, minHeight, maxHeight, currentHeight, init]);
};

export type AutosizeTextAreaRef = {
  textArea: HTMLTextAreaElement;
  maxHeight: number;
  minHeight: number;
  focus: () => void;
};

export type AutosizeTextAreaProps = {
  maxHeight?: number;
  minHeight?: number;
  variant?: 'default' | 'secondary';
} & React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<AutosizeTextAreaRef, AutosizeTextAreaProps>(
  (
    {
      maxHeight = Number.MAX_SAFE_INTEGER,
      minHeight = 52,
      className,
      onChange,
      value,
      variant = 'default',
      ...props
    }: AutosizeTextAreaProps,
    ref: React.Ref<AutosizeTextAreaRef>,
  ) => {
    const textAreaRef = React.useRef<HTMLTextAreaElement | null>(null);
    const [triggerAutoSize, setTriggerAutoSize] = React.useState('');

    useAutosizeTextArea({
      textAreaRef,
      triggerAutoSize: triggerAutoSize,
      maxHeight,
      minHeight,
    });

    useImperativeHandle(ref, () => ({
      textArea: textAreaRef.current as HTMLTextAreaElement,
      focus: () => textAreaRef?.current?.focus(),
      maxHeight,
      minHeight,
    }));

    React.useEffect(() => {
      setTriggerAutoSize((value as string) || '');
    }, [props?.defaultValue, value]);

    return (
      <textarea
        {...props}
        value={value}
        ref={textAreaRef}
        className={cn(
          'border-border bg-input text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground flex w-full rounded-lg border px-3 py-2 text-sm font-medium transition-[color] outline-none disabled:cursor-not-allowed disabled:opacity-50',
          'focus:ring-primary/50 resize-none focus:ring-1 focus:outline-none',
          variant === 'secondary' && 'bg-input text-secondary-foreground resize-none border-none',
          className,
        )}
        onChange={(e) => {
          setTriggerAutoSize(e.target.value);
          onChange?.(e);
        }}
      />
    );
  },
);
Textarea.displayName = 'Textarea';
