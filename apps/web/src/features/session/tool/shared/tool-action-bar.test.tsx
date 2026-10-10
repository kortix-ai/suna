import { TooltipProvider } from '@/components/ui/tooltip';
import { NextIntlClientProvider } from '@/i18n/use-translations';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServicePreviewActions, type ServicePreviewState } from './infrastructure';
import { ShowFileActions } from './show-helpers';

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const preview = {
  navigationEnabled: true,
  proxy: { port: 3000, proxyUrl: 'https://example.test' },
  previewUrl: 'https://example.test',
  isLoading: true,
  handleRefresh: () => {},
  navigateToPreviewTab: () => {},
  openInBrowser: () => {},
} as ServicePreviewState;

describe('show action toolbars', () => {
  for (const compact of [false, true]) {
    test(`file toolbar compact=${compact}`, () => {
      const html = render(<ShowFileActions path="/workspace/report.pdf" compact={compact} />);
      expect(html).toContain('Preview</button>');
      expect(html).toContain(compact ? 'aria-label="More actions"' : 'aria-label="Full screen"');
      expect(html.includes('aria-label="Refresh"')).toBe(!compact);
      expect(html).toContain('active:scale-[0.96]');
    });

    test(`service toolbar compact=${compact}`, () => {
      const html = render(<ServicePreviewActions preview={preview} compact={compact} />);
      expect(html).toContain('Preview</button>');
      expect(html).toContain(compact ? 'aria-label="More actions"' : 'animate-spinner-spin');
      expect(html.includes('animate-spinner-spin')).toBe(!compact);
      expect(html.includes('cursor-not-allowed')).toBe(false);
    });
  }

  test('service toolbar non-compact icon buttons carry accessible names', () => {
    const html = render(<ServicePreviewActions preview={preview} />);
    // An icon-only button has an accessible name on every caller, not only
    // when a caller passes a styling className (ServicePreviewActions passes
    // none).
    expect(html).toContain('aria-label="Refresh"');
    expect(html).toContain('aria-label="Open private preview"');
    // The secondary icon keeps its size without deriving it from the
    // className prop.
    expect(html).toContain('size-4.5');
  });

  test('file panel hides Preview; service navigation disables both open actions', () => {
    expect(render(<ShowFileActions path="/workspace/report.pdf" inPanel />)).not.toContain(
      'Preview</button>',
    );
    const disabled = render(
      <ServicePreviewActions preview={{ ...preview, navigationEnabled: false }} compact />,
    );
    expect(disabled).toContain('disabled=""');
  });
});
