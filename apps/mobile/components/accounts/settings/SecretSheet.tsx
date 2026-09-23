/**
 * Shows a one-time secret (service-account bearer, webhook signing secret)
 * right after creation, with Copy and Done. Opens whenever `secret` is set.
 */

import React, { useEffect, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { CheckIcon as Check, CopyIcon as Copy } from '@/lib/icons';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { Sheet, SheetBody, SheetHeader, type SheetRef } from '@/components/kortix/sheet';
import { haptics } from '@/lib/haptics';

export interface OneTimeSecret {
  /** Sheet title, e.g. "Copy your bearer token". */
  title: string;
  value: string;
}

export function SecretSheet({ secret, onClose }: { secret: OneTimeSecret | null; onClose: () => void }) {
  const ref = useRef<SheetRef>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!secret) return;
    setCopied(false);
    ref.current?.open();
  }, [secret]);

  const copy = async () => {
    if (!secret) return;
    haptics.tap();
    await Clipboard.setStringAsync(secret.value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Sheet ref={ref} enablePanDownToClose onDismiss={onClose}>
      <SheetHeader title={secret?.title} />
      <SheetBody className="gap-3">
        <Card className="gap-0 rounded-2xl border-0 p-4">
          <Text selectable style={{ fontFamily: 'Menlo' }}>
            {secret?.value}
          </Text>
        </Card>
        <Button size="lg" variant="secondary" className="rounded-full" onPress={() => void copy()}>
          <Icon as={copied ? Check : Copy} size={16} />
          <Text>{copied ? 'Copied' : 'Copy'}</Text>
        </Button>
        <Button size="lg" className="rounded-full" onPress={() => ref.current?.close()}>
          <Text>Done</Text>
        </Button>
      </SheetBody>
    </Sheet>
  );
}
