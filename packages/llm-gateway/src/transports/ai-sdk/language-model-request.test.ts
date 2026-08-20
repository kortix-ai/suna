import { describe, expect, it } from 'bun:test';
import {
  LanguageModelRequestError,
  decodeLanguageModelHeaders,
  decodeLanguageModelRequest,
} from './language-model-request';

const HEADERS = {
  authorization: 'Bearer tok',
  'ai-gateway-protocol-version': '0.0.1',
  'ai-language-model-specification-version': '"3"',
  'ai-language-model-id': 'anthropic/claude-fable-5',
  'ai-language-model-streaming': 'true',
};

describe('decodeLanguageModelHeaders', () => {
  it('reads model id, spec version, and streaming from headers', () => {
    const h = decodeLanguageModelHeaders(HEADERS);
    expect(h.modelId).toBe('anthropic/claude-fable-5');
    expect(h.specVersion).toBe('3');
    expect(h.streaming).toBe(true);
    expect(h.protocolVersion).toBe('0.0.1');
  });

  it('accepts BOTH spec version "3" and "4"', () => {
    expect(
      decodeLanguageModelHeaders({ ...HEADERS, 'ai-language-model-specification-version': '4' })
        .specVersion,
    ).toBe('4');
    expect(
      decodeLanguageModelHeaders({ ...HEADERS, 'ai-language-model-specification-version': '"3"' })
        .specVersion,
    ).toBe('3');
  });

  it('treats streaming=false explicitly and defaults to streaming otherwise', () => {
    expect(
      decodeLanguageModelHeaders({ ...HEADERS, 'ai-language-model-streaming': 'false' }).streaming,
    ).toBe(false);
    const { 'ai-language-model-streaming': _omit, ...noStreamHeader } = HEADERS;
    expect(decodeLanguageModelHeaders(noStreamHeader).streaming).toBe(true);
  });

  it('rejects a missing model id header', () => {
    const { 'ai-language-model-id': _omit, ...noModel } = HEADERS;
    expect(() => decodeLanguageModelHeaders(noModel)).toThrow(LanguageModelRequestError);
  });
});

describe('decodeLanguageModelRequest — text + tool + reasoning providerOptions', () => {
  const body = {
    prompt: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'weather in SF?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'let me check', providerOptions: { anthropic: { signature: 'S' } } },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'get_weather', input: { city: 'SF' } },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'get_weather', output: { type: 'text', value: 'sunny' } },
        ],
      },
    ],
    tools: [
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
    toolChoice: { type: 'auto' },
    temperature: 0.7,
    maxOutputTokens: 1024,
    providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } },
  };

  it('preserves messages, tools, and providerOptions', () => {
    const decoded = decodeLanguageModelRequest({ headers: HEADERS, body });

    // System hoisted; roles + tool pairing preserved.
    expect(decoded.call.system).toBe('You are helpful.');
    expect(decoded.call.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);

    // Reasoning providerOptions (the signature) survives the round-trip.
    const assistant = decoded.call.messages[1];
    const reasoningPart = (assistant.content as Array<Record<string, unknown>>).find(
      (p) => p.type === 'reasoning',
    );
    expect(reasoningPart?.providerOptions).toEqual({ anthropic: { signature: 'S' } });

    // Tool-call and tool-result preserved.
    const toolCall = (assistant.content as Array<Record<string, unknown>>).find(
      (p) => p.type === 'tool-call',
    );
    expect(toolCall).toMatchObject({ toolCallId: 'c1', toolName: 'get_weather', input: { city: 'SF' } });

    // Tools lifted into a ToolSet keyed by name.
    expect(decoded.call.tools && Object.keys(decoded.call.tools)).toEqual(['get_weather']);
    expect(decoded.call.toolChoice).toBe('auto');

    // Top-level provider options + generation params preserved verbatim.
    expect(decoded.call.providerOptions).toEqual({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'high' },
    });
    expect(decoded.call.temperature).toBe(0.7);
    expect(decoded.call.maxOutputTokens).toBe(1024);

    expect(decoded.hasImageInput).toBe(false);
  });
});

describe('decodeLanguageModelRequest — v3 file-part normalization', () => {
  it('normalizes a data: URL image part to inline base64 + image flag', () => {
    const b64 = btoa('PNGDATA');
    const body = {
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'file', data: `data:image/png;base64,${b64}`, mediaType: 'image/png' },
          ],
        },
      ],
    };
    const decoded = decodeLanguageModelRequest({ headers: HEADERS, body });
    const userParts = decoded.call.messages[0].content as Array<Record<string, unknown>>;
    const filePart = userParts.find((p) => p.type === 'file') as Record<string, unknown>;
    expect(filePart.mediaType).toBe('image/png');
    expect(filePart.data).toBe(b64);
    expect(decoded.hasImageInput).toBe(true);
  });

  it('normalizes a legacy image-url part to a URL reference', () => {
    const body = {
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'image-url', url: 'https://example.com/cat.png', mediaType: 'image/png' },
          ],
        },
      ],
    };
    const decoded = decodeLanguageModelRequest({ headers: HEADERS, body });
    const userParts = decoded.call.messages[0].content as Array<Record<string, unknown>>;
    const filePart = userParts.find((p) => p.type === 'file') as Record<string, unknown>;
    expect(filePart.data).toBeInstanceOf(URL);
    expect(String(filePart.data)).toBe('https://example.com/cat.png');
    expect(decoded.hasImageInput).toBe(true);
  });

  it('normalizes a legacy {image:"data:..."} shape', () => {
    const b64 = btoa('JPEG');
    const body = {
      prompt: [
        { role: 'user', content: [{ type: 'image', image: `data:image/jpeg;base64,${b64}` }] },
      ],
    };
    const decoded = decodeLanguageModelRequest({ headers: HEADERS, body });
    const userParts = decoded.call.messages[0].content as Array<Record<string, unknown>>;
    const filePart = userParts.find((p) => p.type === 'file') as Record<string, unknown>;
    expect(filePart.mediaType).toBe('image/jpeg');
    expect(filePart.data).toBe(b64);
  });
});
