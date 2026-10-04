import { describe, expect, test } from 'bun:test';
import {
  emailChannelAttachmentArgs,
  findAttachmentRefs,
  type InlineAttachmentFile,
  itemProfileFor,
  redactInlineBytes,
  resolveAttachmentRefs,
} from './attachment-inline';

const PDF_ID = '019fc40d-04dd-7f52-a591-65ab13d2a245';
const PNG_ID = '019fc40d-04dd-7f52-a591-65ab13d2a246';
// Synthetic bytes: a PDF header plus every byte value, so a lossy encoding fails.
const PDF_BYTES = new Uint8Array([
  ...new TextEncoder().encode('%PDF-1.7\n'),
  ...Array.from({ length: 256 }, (_, i) => i),
]);
const PDF_BASE64 = Buffer.from(PDF_BYTES).toString('base64');

const ref = (id: string) => ({ $kortix_attachment: id });

function file(overrides: Partial<InlineAttachmentFile> = {}): InlineAttachmentFile {
  return {
    filename: 'invoice summary.pdf',
    contentType: 'application/pdf',
    contentDisposition: 'attachment',
    bytes: PDF_BYTES,
    ...overrides,
  };
}

function resolve(args: Record<string, unknown>, schema: unknown, files = new Map([[PDF_ID, file()]])) {
  return resolveAttachmentRefs(args, schema, findAttachmentRefs(args), files);
}

const arrayOf = (items: unknown) => ({
  type: 'object',
  properties: { attachments: { type: 'array', items } },
});

/** The Microsoft Graph `sendMail` body as a customer OpenAPI spec declares it. */
const GRAPH_SEND_MAIL_SCHEMA = {
  type: 'object',
  properties: {
    user: { type: 'string', 'x-in': 'path' },
    body: {
      type: 'object',
      properties: {
        message: {
          type: 'object',
          properties: {
            subject: { type: 'string' },
            attachments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  '@odata.type': { type: 'string' },
                  name: { type: 'string' },
                  contentType: { type: 'string' },
                  contentBytes: { type: 'string', format: 'base64url' },
                  isInline: { type: 'boolean' },
                },
              },
            },
          },
        },
        saveToSentItems: { type: 'boolean' },
      },
    },
  },
};

describe('findAttachmentRefs', () => {
  test('finds references at any depth, in array items and in string fields', () => {
    const args = {
      body: {
        message: { attachments: [ref(PDF_ID), { name: 'x', contentBytes: ref(PNG_ID) }] },
      },
    };
    expect(findAttachmentRefs(args)).toEqual([
      { path: ['body', 'message', 'attachments', 0], attachmentId: PDF_ID },
      { path: ['body', 'message', 'attachments', 1, 'contentBytes'], attachmentId: PNG_ID },
    ]);
  });

  test("an upstream API's own attachment_id fields are not references", () => {
    // Regression: many APIs reference their own stored attachments this way.
    const args = { attachments: [{ attachment_id: '12345' }, { attachment_id: PDF_ID, x: 1 }] };
    expect(findAttachmentRefs(args)).toEqual([]);
    expect(resolve(args, arrayOf({ type: 'object' }))).toEqual(args);
    // A marker with extra keys is ordinary data, not a reference.
    expect(findAttachmentRefs({ a: { $kortix_attachment: PDF_ID, other: 1 } })).toEqual([]);
  });

  test('a malformed reference is refused with its location', () => {
    expect(() => findAttachmentRefs({ body: { f: { $kortix_attachment: 7 } } })).toThrow(
      'attachment_ref_invalid: body.f must be {"$kortix_attachment": "<attachment_id>"}',
    );
  });
});

describe('resolveAttachmentRefs', () => {
  test('an attachments[] reference becomes a Graph fileAttachment, byte for byte', () => {
    const args = {
      user: 'sender@example.com',
      body: { message: { subject: 'Report', attachments: [ref(PDF_ID)] }, saveToSentItems: true },
    };
    const out = resolve(args, GRAPH_SEND_MAIL_SCHEMA);
    const attachment = (out.body as any).message.attachments[0];
    expect(attachment).toEqual({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'invoice summary.pdf',
      contentType: 'application/pdf',
      contentBytes: PDF_BASE64,
    });
    expect(new Uint8Array(Buffer.from(attachment.contentBytes, 'base64'))).toEqual(PDF_BYTES);
    // The input is not mutated: audit, digest, and approval keep the reference.
    expect(args.body.message.attachments[0]).toEqual(ref(PDF_ID));
    expect((out.body as any).saveToSentItems).toBe(true);
  });

  test("Graph's official spec types attachments with the base type; @odata.type selects Graph", () => {
    const official = arrayOf({
      allOf: [
        { type: 'object', properties: { id: { type: 'string' } } },
        {
          type: 'object',
          properties: {
            '@odata.type': { type: 'string' },
            name: { type: 'string' },
            contentType: { type: 'string' },
            isInline: { type: 'boolean' },
            size: { type: 'integer' },
          },
        },
      ],
    });
    expect(itemProfileFor((official.properties.attachments as any).items)?.name).toBe('microsoft-graph');
    expect(resolve({ attachments: [ref(PDF_ID)] }, official).attachments).toEqual([
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'invoice summary.pdf',
        contentType: 'application/pdf',
        contentBytes: PDF_BASE64,
      },
    ]);
  });

  test('an inline image carries Graph isInline + contentId', () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const out = resolve(
      { body: { message: { attachments: [ref(PNG_ID)] } } },
      GRAPH_SEND_MAIL_SCHEMA,
      new Map([
        [
          PNG_ID,
          file({
            filename: 'logo.png',
            contentType: 'image/png',
            contentDisposition: 'inline',
            contentId: 'logo',
            bytes: png,
          }),
        ],
      ]),
    );
    expect((out.body as any).message.attachments[0]).toEqual({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'logo.png',
      contentType: 'image/png',
      contentBytes: 'iVBORw==',
      isInline: true,
      contentId: 'logo',
    });
  });

  test('SendGrid, Resend, Postmark, Mailjet, and Brevo shapes come from their exact keys', () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [
        { content: {}, filename: {}, type: {}, disposition: {} },
        { filename: 'invoice summary.pdf', content: PDF_BASE64, type: 'application/pdf', disposition: 'attachment' },
      ],
      [
        { content: {}, filename: {}, content_type: {}, path: {} },
        { filename: 'invoice summary.pdf', content: PDF_BASE64, content_type: 'application/pdf' },
      ],
      [
        { Name: {}, Content: {}, ContentType: {}, ContentID: {} },
        { Name: 'invoice summary.pdf', Content: PDF_BASE64, ContentType: 'application/pdf' },
      ],
      [
        { Filename: {}, Base64Content: {}, ContentType: {} },
        { Filename: 'invoice summary.pdf', Base64Content: PDF_BASE64, ContentType: 'application/pdf' },
      ],
      [{ name: {}, content: {} }, { name: 'invoice summary.pdf', content: PDF_BASE64 }],
    ];
    for (const [properties, expected] of cases) {
      const schema = arrayOf({ type: 'object', properties });
      expect(resolve({ attachments: [ref(PDF_ID)] }, schema).attachments).toEqual([expected]);
    }
  });

  test('a reference in a string field becomes the base64 string (explicit item, GitHub content)', () => {
    const explicit = {
      body: {
        message: {
          attachments: [
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: 'renamed.pdf',
              contentType: 'application/pdf',
              contentBytes: ref(PDF_ID),
            },
          ],
        },
      },
    };
    expect((resolve(explicit, GRAPH_SEND_MAIL_SCHEMA).body as any).message.attachments[0]).toEqual({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'renamed.pdf',
      contentType: 'application/pdf',
      contentBytes: PDF_BASE64,
    });

    const github = { type: 'object', properties: { message: { type: 'string' }, content: { type: 'string' } } };
    expect(resolve({ message: 'add report', content: ref(PDF_ID) }, github)).toEqual({
      message: 'add report',
      content: PDF_BASE64,
    });
  });

  test('an array reference with no object item schema becomes a base64 string', () => {
    expect(resolve({ files: [ref(PDF_ID)] }, {}).files).toEqual([PDF_BASE64]);
  });

  test('an object item schema that matches no known shape is refused with the fix', () => {
    const schema = arrayOf({ type: 'object', properties: { url: { type: 'string' } } });
    expect(() => resolve({ attachments: [ref(PDF_ID)] }, schema)).toThrow(
      'attachment_item_shape_unknown: attachments items declare {url}',
    );
  });
});

describe('emailChannelAttachmentArgs', () => {
  test('attachments[] references become Email channel handles; anywhere else is refused', () => {
    const args = { text: 'hi', attachments: [ref(PDF_ID), { url: 'https://x.test/a.pdf' }] };
    expect(emailChannelAttachmentArgs(args, findAttachmentRefs(args))).toEqual({
      text: 'hi',
      attachments: [{ attachment_id: PDF_ID }, { url: 'https://x.test/a.pdf' }],
    });
    const nested = { body: { file: ref(PDF_ID) } };
    expect(() => emailChannelAttachmentArgs(nested, findAttachmentRefs(nested))).toThrow(
      'attachment_ref_unsupported',
    );
  });
});

describe('redactInlineBytes', () => {
  test('removes echoed base64 and keeps the readable error', () => {
    const echoed = `upstream_400: {"error":"bad attachment","got":"${PDF_BASE64}"}`;
    expect(redactInlineBytes(echoed)).toBe(
      'upstream_400: {"error":"bad attachment","got":"[redacted-bytes]"}',
    );
  });
});
