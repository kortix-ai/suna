/**
 * PermissionPromptCard — the pending tool-permission ask, pinned above the
 * composer (COR-137 Task 7; Paper board 20). Renders in the composer's top
 * slot (`SessionPage`'s `inputSlot`, the same slot the queue panel uses),
 * above the queue, so a permission request is never missed off-screen while
 * the reader is scrolled away from the blocked tool row.
 *
 * Mirrors apps/web `session-permission-prompt.tsx`'s reply semantics (Deny /
 * Allow once / Allow always → `PermissionReply` `reject` / `once` / `always`)
 * on `tool-part-renderer.tsx`'s existing `handlePermissionReply`. The inline
 * prompt under the tool row keeps only a quiet "Waiting for your permission"
 * line — this card is the one place with controls.
 */

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { ShieldWarningIcon } from '@/lib/icons';
import { permissionPromptDetail, permissionPromptTitle } from '@/lib/session/permission-prompt';
import { BUTTON_LABEL_MAX_FONT_SCALE } from '@/lib/ui/font-scale';
import type { PermissionRequest } from '@/lib/opencode/types';
import type { PermissionReply } from '@/components/session/tool/tool-part-renderer';

interface PermissionPromptCardProps {
  permission: PermissionRequest;
  onReply: (requestId: string, reply: PermissionReply) => void | Promise<void>;
}

export function PermissionPromptCard({ permission, onReply }: PermissionPromptCardProps) {
  const [replying, setReplying] = useState(false);

  const reply = useCallback(
    (value: PermissionReply) => {
      if (replying) return;
      setReplying(true);
      // No optimistic remove: the card stays until the runtime accepts the
      // reply, and a failed reply re-enables the controls for a retry
      // (matches `tool-part-renderer.tsx`'s inline prompt).
      void Promise.resolve(onReply(permission.id, value)).finally(() => setReplying(false));
    },
    [replying, permission.id, onReply],
  );

  const title = permissionPromptTitle(permission.permission, permission.metadata);
  const detail = permissionPromptDetail(permission.patterns, permission.metadata);

  return (
    <View className="gap-2 rounded-xl border border-kortix-orange/25 bg-background p-3">
      <View className="flex-row items-center gap-1.5">
        <Icon as={ShieldWarningIcon} size={14} className="text-kortix-orange" />
        <Text variant="small" className="text-kortix-orange">
          Permission needed
        </Text>
      </View>
      <Text variant="small" className="leading-5">
        {title}
      </Text>
      {detail ? (
        <View className="rounded-lg bg-secondary px-3 py-2">
          <Text className="font-mono text-xs text-muted-foreground" numberOfLines={4}>
            {detail}
          </Text>
        </View>
      ) : null}
      <View className="flex-row gap-2">
        <View className="flex-1">
          <Button
            variant="secondary"
            size="lg"
            className="rounded-full"
            disabled={replying}
            onPress={() => reply('reject')}
          >
            <Text maxFontSizeMultiplier={BUTTON_LABEL_MAX_FONT_SCALE.lg}>Deny</Text>
          </Button>
        </View>
        <View className="flex-1">
          <Button
            variant="default"
            size="lg"
            className="rounded-full"
            disabled={replying}
            onPress={() => reply('once')}
          >
            <Text maxFontSizeMultiplier={BUTTON_LABEL_MAX_FONT_SCALE.lg}>Allow once</Text>
          </Button>
        </View>
      </View>
      <View className="self-start">
        <Button
          variant="ghost"
          size="sm"
          disabled={replying}
          onPress={() => reply('always')}
        >
          <Text maxFontSizeMultiplier={BUTTON_LABEL_MAX_FONT_SCALE.sm} className="text-muted-foreground">
            Always allow
          </Text>
        </Button>
      </View>
    </View>
  );
}
