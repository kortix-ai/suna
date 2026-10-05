import { cn } from '@/lib/utils/index';
import { BottomSheetTextInput, useBottomSheetInternal } from '@gorhom/bottom-sheet';
import { cssInterop } from 'nativewind';
import { Platform, TextInput } from 'react-native';

// NativeWind patches only React Native's `TextInput`; give gorhom's input the
// same className → style mapping so `Input` looks identical in and out of a sheet.
cssInterop(BottomSheetTextInput, {
  className: { target: 'style', nativeStyleToProp: { textAlign: true } },
});

/**
 * Inside a gorhom sheet the field renders `BottomSheetTextInput`: gorhom lifts
 * the sheet above the keyboard only for a focused input it registered, so a
 * plain `TextInput` there stays under the keyboard. Outside a sheet
 * `BottomSheetTextInput` throws, so the plain `TextInput` renders.
 */
function Input({ className, ...props }: React.ComponentProps<typeof TextInput> & React.RefAttributes<TextInput>) {
  const inSheet = useBottomSheetInternal(true) !== null;
  const Field = (inSheet ? BottomSheetTextInput : TextInput) as typeof TextInput;
  return (
    <Field
      className={cn(
        'bg-secondary text-foreground font-roobert flex h-11 w-full min-w-0 flex-row items-center rounded-xl px-3.5 py-1 text-base leading-5 sm:h-10',
        props.editable === false &&
        cn(
          'opacity-50',
          Platform.select({ web: 'disabled:pointer-events-none disabled:cursor-not-allowed' })
        ),
        Platform.select({
          web: cn(
            'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground outline-none transition-[color,box-shadow] md:text-sm',
            'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
            'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive'
          ),
          native: 'placeholder:text-muted-foreground',
        }),
        className
      )}
      {...props}
    />
  );
}

export { Input };
