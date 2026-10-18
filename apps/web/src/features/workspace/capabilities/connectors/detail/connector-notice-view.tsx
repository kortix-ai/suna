import type { ReactNode } from 'react';
import { splitNoticeReason } from './connector-notice';
export function ConnectorNoticeRow({
  title,
  detail,
  children,
}: {
  title: string;
  detail: ReactNode;
  children: ReactNode;
}) {
  return (
    <div role="alert" className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-foreground text-sm font-medium">{title}</p>
        {detail}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

/** `401  MCP tools/list failed`: the status code in red, the rest muted mono. */
export function NoticeLogLine({ reason }: { reason: string }) {
  const { code, detail } = splitNoticeReason(reason);
  return (
    <p className="text-muted-foreground flex min-w-0 items-center gap-3 font-mono text-xs">
      {code ? <span className="text-destructive shrink-0">{code}</span> : null}
      <span className="truncate" title={reason}>
        {detail}
      </span>
    </p>
  );
}

export const NOTICE_TITLE = {
  error: 'noticeErrorTitle',
  sign_in: 'noticeSignInTitle',
  no_account: 'noticeNoAccountTitle',
  needs_credential: 'noticeCredentialTitle',
};
export const NOTICE_BODY = {
  error: 'noticeErrorBody',
  sign_in: 'noticeSignInBody',
  no_account: 'noticeNoAccountBody',
  needs_credential: 'noticeCredentialBody',
};
