/**
 * Edit one optional whole-number setting (session lifetime, token lifetime…)
 * in a sheet. Blank saves `null` (no limit). Opens whenever `field` is set.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Sheet, SheetBody, SheetHeader, type SheetRef } from '@/components/kortix/sheet';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { haptics } from '@/lib/haptics';

export interface NumberField {
  title: string;
  value: number | null;
  /** Shown when the field is blank, e.g. "No limit". */
  placeholder: string;
  /** Unit in validation messages, e.g. "minutes". */
  unit: string;
  max: number;
  onSave: (value: number | null) => void;
}

export function NumberFieldSheet({ field, onClose }: { field: NumberField | null; onClose: () => void }) {
  const ref = useRef<SheetRef>(null);
  const [text, setText] = useState('');

  useEffect(() => {
    if (!field) return;
    setText(field.value?.toString() ?? '');
    ref.current?.open();
  }, [field]);

  const save = () => {
    if (!field) return;
    const trimmed = text.trim();
    if (trimmed === '') {
      haptics.tap();
      field.onSave(null);
      ref.current?.close();
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n <= 0) {
      Alert.alert('Enter a whole number', `Use a whole number of ${field.unit}, or leave it blank.`);
      return;
    }
    if (n > field.max) {
      Alert.alert('Value too large', `The maximum is ${field.max} ${field.unit}.`);
      return;
    }
    haptics.tap();
    field.onSave(n);
    ref.current?.close();
  };

  return (
    <Sheet ref={ref} enablePanDownToClose onDismiss={onClose}>
      <SheetHeader title={field?.title} />
      <SheetBody className="gap-3">
        <SheetTextInput
          value={text}
          onChangeText={(t) => setText(t.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          placeholder={field?.placeholder}
          returnKeyType="done"
          onSubmitEditing={save}
        />
        <Button size="lg" className="rounded-full" onPress={save}>
          <Text>Save</Text>
        </Button>
      </SheetBody>
    </Sheet>
  );
}
