import { afterEach, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const stopped = {
  share: {
    project_id: 'synthetic-project',
    session_id: 'synthetic-session',
    resource_type: 'preview',
    sandbox_status: 'stopped',
    label: 'Synthetic preview',
    proxy_path: '',
    public_url: null,
  },
};
let calls = 0;
let failRefresh = false;
let reads = 0;
let emptyMessage = false;
mock.module('@kortix/sdk', () => ({
  SANDBOX_PORTS: {},
  getPublicSessionShare: async () => ({ session: { title: 'Synthetic preview' } }),
  getPublicShareByToken: async () => {
    reads++;
    if (failRefresh && reads === 2) throw new Error('Share refresh failed');
    return reads > 1 ? { share: { ...stopped.share, sandbox_status: 'active' } } : stopped;
  },
  startSessionWithToken: async () => {
    calls++;
    if (!failRefresh && calls === 1) throw new Error(emptyMessage ? '' : 'Session start failed');
  },
}));
mock.module('@/lib/auth-token', () => ({ getAuthToken: async () => 'synthetic-token' }));
mock.module('@/lib/env-config', () => ({
  getEnv: () => ({ BACKEND_URL: 'http://localhost:13008/v1' }),
}));
mock.module('next/navigation', () => ({
  useParams: () => ({ token: 'synthetic-share' }),
  useRouter: () => ({ push: () => {} }),
}));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => ({ raw: (key: string) => key }),
}));
const host = ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
  createElement('button', props, children);
const uiButtonMock = () => ({ Button: host });
mock.module('@/components/ui/button', uiButtonMock);
mock.module('@kortix/ui/button', uiButtonMock);
const presentation = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
mock.module('@/features/auth/auth-card-shell', () => ({ AuthFrame: presentation }));
mock.module('@/features/auth/auth-consent', () => ({ OutcomeTitle: presentation }));
mock.module('@/features/auth/auth-primitives', () => ({ Rise: presentation, StepHeader: presentation }));
const uiHintMock = () => ({
  default: ({ children }: { children?: ReactNode }) => children,
});
mock.module('@/components/ui/hint', uiHintMock);
mock.module('@kortix/ui/hint', uiHintMock);
mock.module('@/components/sidebar/kortix-logo', () => ({ KortixLogo: () => null }));
mock.module('./public-file-share-view', () => ({ PublicFileShareView: () => null }));
mock.module('./public-transcript-share-view', () => ({ PublicTranscriptShareView: () => null }));
const { default: Page } = await import('./page');
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
});

for (const failure of ['session start', 'metadata refresh', 'empty message']) {
  test(`${failure} failure is handled and Retry starts again`, async () => {
    calls = 0;
    reads = 0;
    failRefresh = failure === 'metadata refresh';
    emptyMessage = failure === 'empty message';
    await act(async () => {
      renderer = create(createElement(Page));
    });
    if (!renderer) throw new Error('Page did not mount');
    const page = renderer;
    const start = page.root.findAllByType('button').find((node) => node.props.onClick);
    if (!start) throw new Error('Start button missing');
    await act(async () => {
      await start.props.onClick();
    });
    expect(JSON.stringify(page.toJSON())).toContain(
      failRefresh ? 'Share refresh failed' : emptyMessage ? 'error' : 'Session start failed',
    );
    const retry = page.root.findAllByType('button').find((node) => node.children.includes('retry'));
    if (!retry) throw new Error('Retry button missing');
    expect(retry.props.disabled).toBe(false);
    await act(async () => {
      await retry.props.onClick();
    });
    expect(calls).toBe(2);
    expect(JSON.stringify(page.toJSON())).not.toContain('failed');
    expect(page.root.findAllByType('button').some((node) => node.children.includes('retry'))).toBe(false);
    expect(JSON.stringify(page.toJSON())).not.toContain(
      'autoAppPublicShareSessionTokenPageJsxTextStartSessiond4216ec8',
    );
  });
}
