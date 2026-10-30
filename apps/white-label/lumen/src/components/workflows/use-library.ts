'use client';

import { useFirm } from '@/components/access';
import { api } from '@convex/_generated/api';
import { useMutation, useQuery } from 'convex/react';
import { useEffect, useRef } from 'react';

/** The firm library (optionally one kind). A firm made before the library existed gets the default items on first use. */
export function useLibrary(kind?: 'playbook' | 'template') {
  const firm = useFirm();
  const all = useQuery(api.library.list, { firmId: firm._id });
  const ensure = useMutation(api.library.ensureDefaults);
  const asked = useRef(false);
  useEffect(() => {
    if (all && all.length === 0 && !asked.current) {
      asked.current = true;
      void ensure({ firmId: firm._id }).catch(() => undefined);
    }
  }, [all, ensure, firm._id]);
  return all === undefined || all === null ? all : kind ? all.filter((i) => i.kind === kind) : all;
}
