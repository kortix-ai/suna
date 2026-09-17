import { KORTIX_CLI_INSTALL_COMMAND } from '@/lib/kortix-cli';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SessionTerminalConnectBar,
  SessionTerminalConnectSteps,
} from './session-terminal-connect-bar';

describe('SessionTerminalConnectBar', () => {
  test('collapsed bar is one quiet row: no command text competes with the terminal', () => {
    const html = renderToStaticMarkup(<SessionTerminalConnectBar projectSessionId="ps-123" />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain(KORTIX_CLI_INSTALL_COMMAND);
    expect(html).not.toContain('kortix sessions connect ps-123');
  });

  test('expanded steps give the install command, then the session connect command', () => {
    const html = renderToStaticMarkup(
      <SessionTerminalConnectSteps id="steps" projectSessionId="ps-123" />,
    );
    const install = html.indexOf(KORTIX_CLI_INSTALL_COMMAND);
    const connect = html.indexOf('kortix sessions connect ps-123');
    expect(install).toBeGreaterThan(-1);
    expect(connect).toBeGreaterThan(install);
    expect(html.match(/<li/g)?.length).toBe(2);
  });
});
