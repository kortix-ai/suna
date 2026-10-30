import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import messages from '../../../../apps/web/translations/en.json';
import { SidebarProvider } from '../primitives/sidebar';
import { IntlTestProvider as NextIntlClientProvider } from '../test-utils/intl';
import {
  ProjectRepositoryDisconnectedAlertView,
  RepositoryDisconnectedBanner,
  repositoryDisconnectOf,
} from './repository-disconnected';

const connection = (status: string, code: string | null) => ({
  status,
  last_error_code: code,
  repo_owner: 'acme',
  repo_name: 'app',
});

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={{ repositoryDisconnected: messages.repositoryDisconnected }}
      timeZone="UTC"
      onError={() => {}}
    >
      <SidebarProvider defaultOpen>{node}</SidebarProvider>
    </NextIntlClientProvider>,
  );
}

describe('repositoryDisconnectOf', () => {
  test('reads the reason, owner and repository off a disconnected connection', () => {
    expect(repositoryDisconnectOf(connection('error', 'app_uninstalled'))).toEqual({
      reason: 'app_uninstalled',
      owner: 'acme',
      repository: 'acme/app',
    });
  });

  test('a healthy connection, or another error, is not a disconnect', () => {
    expect(repositoryDisconnectOf(connection('connected', null))).toBeNull();
    expect(repositoryDisconnectOf(connection('error', 'push_rejected'))).toBeNull();
    expect(repositoryDisconnectOf(null)).toBeNull();
  });
});

describe('RepositoryDisconnectedBanner', () => {
  test('names the cause, who fixes it, and offers Reconnect GitHub', () => {
    const html = render(
      <RepositoryDisconnectedBanner projectId="p1" disconnect={repositoryDisconnectOf(connection('error', 'app_uninstalled'))} />,
    );
    expect(html).toContain('GitHub disconnected');
    expect(html).toContain('The Kortix GitHub App was uninstalled from acme, so Kortix cannot reach acme/app.');
    expect(html).toContain('Reconnect GitHub');
  });

  test('each reason has its own sentence', () => {
    expect(render(<RepositoryDisconnectedBanner projectId="p1" disconnect={repositoryDisconnectOf(connection('error', 'app_suspended'))} />)).toContain('is suspended on acme');
    expect(render(<RepositoryDisconnectedBanner projectId="p1" disconnect={repositoryDisconnectOf(connection('error', 'repo_not_accessible'))} />)).toContain('deleted, renamed, or removed');
  });

  test('without a connection it shows the API sentence', () => {
    const html = render(<RepositoryDisconnectedBanner projectId="p1" disconnect={null} fallbackMessage="Kortix cannot reach acme/app." />);
    expect(html).toContain('Kortix cannot reach acme/app.');
  });
});

describe('ProjectRepositoryDisconnectedAlertView', () => {
  test('the sidebar shows the alert only while the repository is disconnected', () => {
    expect(render(<ProjectRepositoryDisconnectedAlertView projectId="p1" disconnect={null} />)).not.toContain('GitHub disconnected');
    const html = render(
      <ProjectRepositoryDisconnectedAlertView
        projectId="p1"
        disconnect={repositoryDisconnectOf(connection('error', 'app_uninstalled'))}
        defaultOpen
      />,
    );
    expect(html).toContain('GitHub disconnected');
    expect(html).toContain('Reconnect GitHub');
    expect(html).toContain('Open Git settings');
    expect(html).toContain('/projects/p1/customize/settings?section=git');
  });
});
