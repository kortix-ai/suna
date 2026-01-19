'use client';

import type { UserEmailLinkProps } from '../types';

export function UserEmailLink({ email, onUserClick, className = '' }: UserEmailLinkProps) {
  if (!email) {
    return <span className="text-muted-foreground">Unknown user</span>;
  }

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onUserClick(email);
      }}
      className={`text-primary hover:underline hover:text-primary/80 transition-colors text-left ${className}`}
    >
      {email}
    </button>
  );
}
