/**
 * "Stopped by {name}": one quiet line under a turn that another member
 * stopped. The viewer's own stop shows nothing (`turnStoppedBy`), as on web.
 * Same type as the error row's meta lines (`text-xs text-muted-foreground`).
 */
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/text';
import { TURN_TYPE } from '@/components/session/tool/shared/styles';

export function TurnStoppedBy({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <Text variant="muted" numberOfLines={1} style={TURN_TYPE.xs}>
      {t('sessions.stoppedBy', { name })}
    </Text>
  );
}
