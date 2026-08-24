/**
 * GET /v1/p/config — how this deployment addresses previews.
 *
 * The hostname shape (`{env}-p{port}-{label}.{domain}`) is a deployment fact:
 * it depends on the wildcard domain the operator serves and on which
 * environment this API is. A client cannot derive it from its backend URL
 * without re-implementing — and then drifting from — preview-hosts.ts.
 *
 * So the API states it once, as a template with two slots, and the SDK
 * substitutes. A deployment with no preview domain returns null, and clients
 * keep using the path proxy. Unauthenticated on purpose: it is the same
 * information the URL bar shows the moment any preview opens.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { makeOpenApiApp, json } from '../../openapi';
import { previewUrlTemplate } from '../preview-hosts';

const previewConfig = makeOpenApiApp();

const PreviewConfigSchema = z.object({
  preview_url_template: z
    .string()
    .nullable()
    .openapi({
      description:
        'Origin template for a sandbox port, with `{port}` and `{sandbox}` slots — ' +
        '`{sandbox}` takes the raw external id, lowercased with `_` replaced by `-`. ' +
        'Null when this deployment serves no preview domain; clients then use ' +
        '`/v1/p/{sandbox}/{port}/`.',
      example: 'https://dev-p{port}-{sandbox}.p.kortix.com',
    }),
});

previewConfig.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['preview'],
    summary: 'Preview addressing for this deployment',
    responses: {
      200: json(PreviewConfigSchema, 'Preview addressing'),
    },
  }),
  async (c) => c.json({ preview_url_template: previewUrlTemplate() }, 200),
);

export { previewConfig };
