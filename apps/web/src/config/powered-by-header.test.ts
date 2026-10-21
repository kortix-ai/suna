import { expect, test } from 'bun:test';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import config from '../../next.config';

const resolved = await config(PHASE_DEVELOPMENT_SERVER);

test('the wrapped web config disables the Next.js response header', () => {
  expect(resolved.poweredByHeader).toBe(false);
});
