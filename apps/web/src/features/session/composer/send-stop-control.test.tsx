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
