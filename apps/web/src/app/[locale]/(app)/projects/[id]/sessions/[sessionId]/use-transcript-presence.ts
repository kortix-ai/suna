'use client';

import { useState } from 'react';
import type { UseSessionResult } from '@kortix/sdk/react';

/** Keep a readable conversation visible across transient history refreshes. */
export function useTranscriptPresence(savedTranscript: UseSessionResult['savedTranscript']) {
  const [sawTranscript, setSawTranscript] = useState(false);
  if (savedTranscript === 'shown' && !sawTranscript) setSawTranscript(true);
  return savedTranscript === 'shown' || sawTranscript;
}
