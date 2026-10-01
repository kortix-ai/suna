'use client';

import { Badge } from '@/components/ui/badge';
import Hint from '@/components/ui/hint';
import { useTranslations } from '@/i18n/use-translations';
import { LockIcon, UsersIcon, UsersThreeIcon } from '@phosphor-icons/react';

import type { AccountVisibility } from './connector-connections';

/**
 * Who may use a connector account or a secret value, as one small badge: only
 * you, everyone in the project, or the first names. The hint lists everyone.
 */
export function AudienceBadge({
  visibility,
  labels,
}: {
  visibility: AccountVisibility;
  /** Every audience label, for the hint. */
  labels: readonly string[];
}) {
  const tSharing = useTranslations('accessSharing');
  return (
    <Hint
      label={
        visibility.kind === 'named'
          ? tSharing('sharedWith', { names: labels.join(', ') })
          : visibility.kind === 'everyone'
            ? tSharing('everyoneMeta')
            : tSharing('onlyYouDescription')
      }
    >
      <Badge variant="outline" size="xs" data-testid="account-visibility">
        {visibility.kind === 'you' ? (
          <LockIcon />
        ) : visibility.kind === 'everyone' ? (
          <UsersThreeIcon />
        ) : (
          <UsersIcon />
        )}
        {visibility.kind === 'you'
          ? tSharing('onlyYou')
          : visibility.kind === 'everyone'
            ? tSharing('visibilityEveryone')
            : visibility.more > 0
              ? tSharing('visibilityNamedMore', { names: visibility.names.join(', '), count: visibility.more })
              : visibility.names.join(', ')}
      </Badge>
    </Hint>
  );
}
