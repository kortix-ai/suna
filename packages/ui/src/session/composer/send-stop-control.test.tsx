import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SendStopControl, type SendStopControlProps } from './send-stop-control';

const idle: SendStopControlProps = {
  isSending: false,
  isBusy: false,
  stopDisabled: false,
  escCount: 0,
  lockForQuestion: false,
  questionCanAct: false,
  hasText: true,
  canSubmit: true,
  submitDisabled: false,
  disabled: false,
  modelUnavailable: false,
  onSubmit: () => {},
};

const REASON = 'Retry or remove the failed attachment.';

describe('the Send control states why it refuses', () => {
  test('a failed attachment disables Send and names the reason in its tooltip', () => {
    const markup = renderToStaticMarkup(
      <SendStopControl {...idle} submitDisabled attachmentFailed />,
    );
    expect(markup).toContain(`title="${REASON}"`);
    expect(markup).toContain('aria-label="Send message"');
    expect(markup).toMatch(/<button[^>]*\sdisabled=""/);
  });

  test('an attachment the selected model cannot read disables Send and names the reason', () => {
    const reason = 'DeepSeek V4 Flash can’t read images — remove them or pick another model';
    const markup = renderToStaticMarkup(
      <SendStopControl {...idle} submitDisabled attachmentUnsupported={reason} />,
    );
    expect(markup).toContain('title="DeepSeek V4 Flash can’t read images — remove them or pick another model"');
    expect(markup).toMatch(/<button[^>]*\sdisabled=""/);
  });

  test('without a failed attachment Send stays enabled and gives no refusal', () => {
    const markup = renderToStaticMarkup(<SendStopControl {...idle} />);
    expect(markup).not.toContain(REASON);
    expect(markup).not.toMatch(/<button[^>]*\sdisabled=""/);
  });
});

describe('editing a queued message shows Submit, never Stop', () => {
  test('a busy session with a submit label renders the labeled Submit button, not Stop', () => {
    const markup = renderToStaticMarkup(
      <SendStopControl {...idle} isBusy onStop={() => {}} submitLabel="Submit" />,
    );
    expect(markup).toContain('>Submit</button>');
    expect(markup).not.toContain('aria-label="Stop');
    expect(markup).not.toMatch(/<button[^>]*\sdisabled=""/);
  });

  test('Submit is disabled while the edited draft is empty', () => {
    const markup = renderToStaticMarkup(
      <SendStopControl {...idle} isBusy canSubmit={false} hasText={false} submitLabel="Submit" />,
    );
    expect(markup).toContain('>Submit</button>');
    expect(markup).toMatch(/<button[^>]*\sdisabled=""/);
  });

  test('without a submit label a busy session still shows Stop', () => {
    const markup = renderToStaticMarkup(<SendStopControl {...idle} isBusy onStop={() => {}} />);
    expect(markup).not.toContain('>Submit</button>');
  });
});

describe('a viewer who may not stop the running turn gets Send, never Stop', () => {
  test('busy with canStop false renders Send, so a message queues', () => {
    const markup = renderToStaticMarkup(<SendStopControl {...idle} isBusy onStop={() => {}} canStop={false} />);
    expect(markup).toContain('aria-label="Send message"');
    expect(markup).not.toContain('aria-label="Stop');
  });

  test('busy with canStop true (or unset) and nothing typed renders Stop only', () => {
    const empty = { ...idle, hasText: false, canSubmit: false };
    for (const markup of [
      renderToStaticMarkup(<SendStopControl {...empty} isBusy onStop={() => {}} canStop />),
      renderToStaticMarkup(<SendStopControl {...empty} isBusy onStop={() => {}} />),
    ]) {
      expect(markup).toContain('aria-label="Stop');
      expect(markup).not.toContain('aria-label="Send message"');
    }
  });
});

// KRTX-2556: with a follow-up typed during a turn, mouse users saw only Stop.
// One click ended the run and the follow-up stayed unsent. Enter sends it.
describe('a follow-up typed during a turn', () => {
  test('gets Send, with Stop still beside it', () => {
    const markup = renderToStaticMarkup(<SendStopControl {...idle} isBusy onStop={() => {}} />);
    expect(markup).toContain('aria-label="Send message"');
    expect(markup).toContain('aria-label="Stop');
    // Send is the last control, where the eye and the pointer already are.
    expect(markup.lastIndexOf('aria-label="Send message"')).toBeGreaterThan(markup.indexOf('aria-label="Stop'));
    expect(markup).not.toMatch(/aria-label="Send message"[^>]*\sdisabled=""/);
  });

  test('a follow-up that cannot be sent yet keeps Send disabled and Stop enabled', () => {
    const markup = renderToStaticMarkup(
      <SendStopControl {...idle} isBusy onStop={() => {}} submitDisabled attachmentFailed />,
    );
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Send message"|<button[^>]*aria-label="Send message"[^>]*disabled=""/);
    expect(markup).toMatch(/<button(?![^>]*disabled="")[^>]*aria-label="Stop/);
  });
});
