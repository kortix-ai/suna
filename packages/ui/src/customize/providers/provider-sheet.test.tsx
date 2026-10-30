import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ConnectChoice,
  DeviceCode,
  ProviderAccessRow,
  ProviderKeyForm,
  type ProviderKeyFormProps,
  ProviderModelsList,
  SavedKey,
  providerKeyFieldId,
} from './provider-sheet';

const GROQ = { id: 'groq', label: 'Groq', envVars: ['GROQ_API_KEY'], helpUrl: 'https://console.groq.com/keys' };
const BEDROCK = {
  id: 'amazon-bedrock',
  label: 'Amazon Bedrock',
  envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
  helpUrl: null,
};

function form(overrides: Partial<ProviderKeyFormProps> = {}) {
  return renderToStaticMarkup(
    <ProviderKeyForm
      entry={GROQ}
      values={{}}
      onValueChange={() => {}}
      onSave={() => {}}
      saving={false}
      {...overrides}
    />,
  );
}

describe('ProviderKeyForm — an explicit save', () => {
  test('one masked field, labelled, and a Save button', () => {
    const out = form();
    expect(out.match(/type="password"/g)?.length).toBe(1);
    expect(out).toContain(`for="${providerKeyFieldId('groq', 'GROQ_API_KEY')}"`);
    expect(out).toContain('Save key');
    expect(out).toContain('GROQ_API_KEY');
  });

  test('Save is disabled until every field has a value', () => {
    expect(form()).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(form({ values: { GROQ_API_KEY: 'gsk_123' } })).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  test('a multi-field credential is one box with every env var named', () => {
    const out = form({ entry: BEDROCK });
    expect(out.match(/type="password"/g)?.length).toBe(3);
    expect(out).toContain('AWS_ACCESS_KEY_ID · AWS_SECRET_ACCESS_KEY · AWS_REGION');
    expect(form({ entry: BEDROCK, values: { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' } })).toMatch(
      /<button[^>]*type="submit"[^>]*disabled/,
    );
  });

  test('a failed save stays next to the field', () => {
    const out = form({ error: 'Groq rejected this key (401).' });
    expect(out).toContain('role="alert"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('Groq rejected this key (401).');
  });

  test('links to where the key comes from, and offers Cancel only when asked', () => {
    expect(form()).toContain('Get a key from Groq');
    expect(form()).not.toContain('Cancel');
    expect(form({ onCancel: () => {} })).toContain('Cancel');
  });
});

describe('SavedKey', () => {
  test('shows that a key exists without a field to type into', () => {
    const out = renderToStaticMarkup(<SavedKey envVars={['GROQ_API_KEY']} onReplace={() => {}} />);
    expect(out).not.toContain('<input');
    expect(out).toContain('Saved key');
    expect(out).toContain('Replace');
  });

  test('read-only: no Replace', () => {
    expect(renderToStaticMarkup(<SavedKey envVars={['GROQ_API_KEY']} />)).not.toContain('Replace');
  });
});

describe('ConnectChoice — two ways into OpenAI', () => {
  test('a subscription sign-in and an API key', () => {
    const out = renderToStaticMarkup(
      <ConnectChoice name="ChatGPT" plan="ChatGPT Plus or Pro" providerLabel="OpenAI" onSignIn={() => {}} onUseKey={() => {}} />,
    );
    expect(out).toContain('Sign in with ChatGPT');
    expect(out).toContain('Continue with ChatGPT');
    expect(out).toContain('Use an API key');
    expect(out).toContain('Billed by OpenAI per token');
  });
});

describe('DeviceCode', () => {
  test('the code as boxes, the link by host, the three steps', () => {
    const out = renderToStaticMarkup(
      <DeviceCode name="ChatGPT" code="QH7K-92XM" url="https://auth.openai.com/codex/device" onCopy={() => {}} />,
    );
    expect(out).toContain('aria-label="QH7K-92XM"');
    expect(out.match(/font-mono text-lg/g)?.length).toBe(8);
    expect(out).toContain('Open auth.openai.com');
    expect(out).toContain('Open the link and sign in to ChatGPT');
    expect(out).toContain('data-slot="stepper"');
    expect(out.match(/data-slot="stepper-item"/g)?.length).toBe(3);
    expect(out).toContain('Waiting for you to finish in the browser');
  });

  test('before the code arrives it says sign-in is starting', () => {
    const out = renderToStaticMarkup(<DeviceCode name="ChatGPT" code={null} url={null} onCopy={() => {}} />);
    expect(out).toContain('Starting sign-in');
    expect(out).not.toContain('Copy code');
  });
});

describe('ProviderModelsList', () => {
  const models = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: `Model ${id}`, limit: { context: 200_000 } }));

  test('lists every model, titled by connection state', () => {
    const connected = renderToStaticMarkup(<ProviderModelsList models={models} connected />);
    expect(connected).toContain('5 models');
    expect(connected).toContain('Model e');
    expect(connected).not.toContain('View all');
    const not = renderToStaticMarkup(<ProviderModelsList models={models} connected={false} />);
    expect(not).toContain('What this unlocks');
  });
});

describe('ProviderAccessRow — the provider on/off switch', () => {
  const row = (overrides: Partial<Parameters<typeof ProviderAccessRow>[0]> = {}) =>
    renderToStaticMarkup(
      <ProviderAccessRow
        name="OpenAI"
        enabled
        isDefault={false}
        pending={false}
        canWrite
        onChange={() => {}}
        {...overrides}
      />,
    );

  test('a labelled switch in the sheet, not a menu', () => {
    const out = row();
    expect(out).toContain('Enable OpenAI');
    expect(out).toContain('role="switch"');
    expect(out).toContain('aria-checked="true"');
    expect(out).not.toMatch(/role="switch"[^>]*disabled/);
  });

  test('the project default provider cannot be switched off', () => {
    const out = row({ isDefault: true });
    expect(out).toMatch(/role="switch"[^>]*disabled/);
    expect(out).toContain('Choose a project default from another provider');
  });

  test('read-only members see the state, not a control', () => {
    expect(row({ canWrite: false })).toMatch(/role="switch"[^>]*disabled/);
  });
});
