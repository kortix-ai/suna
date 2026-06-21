import { afterEach, describe, expect, it, vi } from 'vitest';
import { userFactory } from '../_support/factories';

vi.mock('../_support/fixtures', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_support/fixtures')>();
  return {
    ...actual,
    sampleEnv: { ...actual.sampleEnv, KORTIX_WEB_URL: 'https://web.test' },
  };
});

import { notifyProjectCreated, type Mailer } from './example-notifier';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('notifyProjectCreated', () => {
  it('sends a single email to the owner via the injected mailer (vi.fn spy)', async () => {
    const send = vi.fn<Mailer['send']>().mockResolvedValue();
    const owner = userFactory();

    await notifyProjectCreated({ send }, owner.email, 'Apollo');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      owner.email,
      'Project Apollo is ready',
      expect.stringContaining('https://web.test'),
    );
  });

  it('propagates a rejected send (vi.mock applied to a module dependency)', async () => {
    const send = vi.fn<Mailer['send']>().mockRejectedValue(new Error('smtp down'));

    await expect(notifyProjectCreated({ send }, 'a@example.test', 'Hermes')).rejects.toThrow('smtp down');
  });
});
