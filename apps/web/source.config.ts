import { z } from 'zod';
import { defineDocs, defineCollections, defineConfig, frontmatterSchema } from 'fumadocs-mdx/config';

export const docs = defineDocs({
  dir: 'content/docs',
});

export const blog = defineCollections({
  type: 'doc',
  dir: 'content/blog',
  schema: frontmatterSchema.extend({
    date: z.coerce.date(),
    slug: z.string().optional(),
    author: z.string().optional(),
  }),
});

export default defineConfig();
