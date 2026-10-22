import { expect, spyOn, test } from 'bun:test';
import { createKortix } from './kortix';

// `createKortix()` writes the process-global platform config. A second global
// client with a different backend or token source silently re-points the
// first. The write stays (hosts that re-create a client rely on it); the SDK
// says so once. `{ global: false }` (scoped clients) never writes and never warns.
// Run with `--isolate`: the warning is once per process.

const tokenA = async () => 'a';
const tokenB = async () => 'b';

test('a second global client with another backend or token warns once; scoped clients do not', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    createKortix({ backendUrl: 'http://one.test', getToken: tokenA });
    createKortix({ backendUrl: 'http://one.test', getToken: tokenA });
    expect(warn).not.toHaveBeenCalled();

    createKortix({ backendUrl: 'http://one.test', getToken: tokenB, }, { global: false });
    expect(warn).not.toHaveBeenCalled();

    createKortix({ backendUrl: 'http://two.test', getToken: tokenA });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('createScopedKortix');

    createKortix({ backendUrl: 'http://three.test', getToken: tokenB });
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});
