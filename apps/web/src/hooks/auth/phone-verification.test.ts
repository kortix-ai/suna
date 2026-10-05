import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('phone factor hooks retain the active mutation and query contracts', () => {
  const source = readFileSync(new URL('./phone-verification.ts', import.meta.url), 'utf8');
  const barrel = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  for (const hook of ['useEnrollPhoneNumber', 'useCreateChallenge', 'useVerifyChallenge', 'useListFactors', 'useUnenrollFactor', 'useGetAAL']) {
    expect(source).toContain(`export const ${hook} = () => {`);
    expect(barrel).toContain(`  ${hook},`);
  }
  expect(source).toContain('mutationFn: phoneVerificationService.unenrollFactor,');
  expect(source).toContain("queryKey: ['phone-verification-factors']");
  expect(source).toContain("queryKey: ['mfa-aal']");
});
