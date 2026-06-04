'use client';

import React from 'react';
import { TunnelScopeToggles } from './tunnel-scope-toggles';

interface TunnelPermissionManagerProps {
  tunnelId: string;
}

export function TunnelPermissionManager({ tunnelId }: TunnelPermissionManagerProps) {
  return <TunnelScopeToggles tunnelId={tunnelId} />;
}
