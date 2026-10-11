import { Badge } from '@/components/ui/badge';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import { STATUS_DOT, STATUS_WORD, type ConnectorStatusTone } from './connector-status';

const STATUS_BADGE = {
  working: 'success',
  pending: 'info',
  error: 'destructive',
  setup: 'warning',
} as const;

/** A connector's state as a Badge with its dot: Working, Error, or Needs setup. */
export function ConnectorStatusBadge({ tone }: { tone: ConnectorStatusTone }) {
  const t = useTranslations('connectorPages');
  return (
    <Badge variant={STATUS_BADGE[tone]} size="sm">
      <span data-slot="status-dot" aria-hidden className={cn('rounded', STATUS_DOT[tone])} />
      {t(STATUS_WORD[tone])}
    </Badge>
  );
}
