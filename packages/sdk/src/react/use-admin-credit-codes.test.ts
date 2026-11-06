import { describe, expect, test } from 'bun:test';
import {
  ADMIN_CREDIT_CODES_PATH,
  adminCreditCodePath,
  useAdminCreateCreditCode,
  useAdminCreditCodes,
  useAdminSetCreditCodeActive,
} from './use-admin-credit-codes';

describe('admin credit codes contract', () => {
  test('the list and create routes are /admin/api/credit-codes', () => {
    expect(ADMIN_CREDIT_CODES_PATH).toBe('/admin/api/credit-codes');
  });

  test('adminCreditCodePath targets one code by id', () => {
    expect(adminCreditCodePath('code_1')).toBe('/admin/api/credit-codes/code_1');
  });

  test('the three hooks are exported', () => {
    expect(typeof useAdminCreditCodes).toBe('function');
    expect(typeof useAdminCreateCreditCode).toBe('function');
    expect(typeof useAdminSetCreditCodeActive).toBe('function');
  });
});
