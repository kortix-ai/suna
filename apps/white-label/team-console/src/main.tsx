import { UiProvider } from '@kortix/ui';
import { IconProvider } from '@kortix/ui/icon-provider';
import { Toaster } from '@kortix/ui/toast';
import { TooltipProvider } from '@kortix/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { Link, navigation } from './router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <UiProvider link={Link} navigation={navigation}>
        <IconProvider>
          <TooltipProvider delayDuration={200}>
            <App />
          </TooltipProvider>
          <Toaster />
        </IconProvider>
      </UiProvider>
    </QueryClientProvider>
  </StrictMode>,
);
