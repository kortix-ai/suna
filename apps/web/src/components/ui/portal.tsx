import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getPortalRoot } from '@/lib/portal-root';

interface PortalProps {
  children: React.ReactNode;
}

export function Portal({ children }: PortalProps) {
  const [mounted, setMounted] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setMounted(true);
    setContainer(getPortalRoot());
    return () => setMounted(false);
  }, []);

  if (!mounted || !container) return null;

  return createPortal(children, container);
}
