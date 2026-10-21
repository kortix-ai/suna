'use client';

import { useEffect, useState } from 'react';
import type { UseSessionResult } from '@kortix/sdk/react';

/** Keep a readable conversation visible across transient history refreshes. */
export function useTranscriptPresence(savedTranscript: UseSessionResult['savedTranscript']) {
  const [sawTranscript, setSawTranscript] = useState(false);
  useEffect(() => {
    if (savedTranscript === 'shown') setSawTranscript(true);
  }, [savedTranscript]);
  return savedTranscript === 'shown' || sawTranscript;
}
