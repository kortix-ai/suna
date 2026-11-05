import { useTranslations } from '../../i18n';
/** The canonical audit timeline keeps this record even after inbox delivery. */
export function ModelSwitchEvent({ summary }: { summary: Record<string, unknown> | null | undefined }) {
  const t = useTranslations('sessionModelSwitch');
  if (typeof summary?.to !== 'string') return null;
  return (
    <div className="text-muted-foreground mt-1 space-y-1 text-xs">
      <p>{typeof summary.from === 'string' ? summary.from : '—'} → {summary.to}</p>
      <p>{typeof summary.actor_session_id === 'string' ? t('agentSession', { id: summary.actor_session_id }) : t('human')}</p>
      {typeof summary.prompt === 'string' ? <p className="whitespace-pre-wrap">{summary.prompt}</p> : null}
    </div>
  );
}

export function ModelSwitchHistory({ history, current }: { history: unknown; current?: unknown }) {
  const t = useTranslations('sessionModelSwitch');
  if (!Array.isArray(history)) return null;
  return <><p className="text-muted-foreground mx-auto w-full max-w-2xl px-4 text-xs">{typeof current === 'string' ? current : '—'}</p><ol aria-label={t('listLabel')} className="mx-auto w-full max-w-2xl space-y-2 px-4">
    {history.map((item) => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') return null;
      return <li key={item.id}>
        <ModelSwitchEvent summary={item} />
        {typeof item.at === 'string' ? <time className="text-muted-foreground text-xs" dateTime={item.at}>{item.at}</time> : null}
      </li>;
    })}
  </ol></>;
}
