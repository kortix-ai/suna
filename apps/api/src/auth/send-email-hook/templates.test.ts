import { expect, test } from 'bun:test';
import { renderAuthEmail } from './templates';

for (const actionType of ['signup', 'magiclink'] as const) {
  test(`${actionType} offers the same usable code in HTML and plain text`, () => {
    const email = renderAuthEmail({ actionType, actionUrl: 'https://auth.example.test/verify', token: '123456' });
    expect(email.html).toContain('123456');
    expect(email.text).toContain('123456');
    expect(email.html).toContain('https://auth.example.test/verify');
  });
}
