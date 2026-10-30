import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { KORTIX_CLI_INSTALL_COMMAND } from './kortix-cli';
import { useDeploymentCliInstallCommand } from './use-deployment-cli-install-command';

function InstallCommandProbe() {
  return <span>{useDeploymentCliInstallCommand(undefined)}</span>;
}

test('keeps the server and first browser render identical before reading the browser origin', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

  try {
    Reflect.deleteProperty(globalThis, 'window');
    const serverHtml = renderToStaticMarkup(<InstallCommandProbe />);

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'http://10.0.0.5:3000' } },
    });
    const firstBrowserHtml = renderToStaticMarkup(<InstallCommandProbe />);

    expect(serverHtml).toBe(firstBrowserHtml);
    expect(serverHtml).toContain(KORTIX_CLI_INSTALL_COMMAND);
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
});
