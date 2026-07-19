import { expect, test } from 'bun:test';

import {
  getKortixCliInstallCommand,
  KORTIX_CLI_DEV_INSTALL_COMMAND,
  KORTIX_CLI_INSTALL_COMMAND,
} from './kortix-cli';

test('uses the mutable dev CLI channel on dev builds', () => {
  expect(getKortixCliInstallCommand('0.10.13-dev.fca20702')).toBe(KORTIX_CLI_DEV_INSTALL_COMMAND);
  expect(getKortixCliInstallCommand('dev')).toBe(KORTIX_CLI_DEV_INSTALL_COMMAND);
});

test('keeps stable installs on staging and production releases', () => {
  expect(getKortixCliInstallCommand('0.10.13')).toBe(KORTIX_CLI_INSTALL_COMMAND);
  expect(getKortixCliInstallCommand(undefined)).toBe(KORTIX_CLI_INSTALL_COMMAND);
});
