/**
 * The extraction contract.
 *
 * This schema is doing two jobs at once. It is the JSON Schema handed to the
 * model to constrain decoding, and it is the gate every response must pass
 * before anything is stored. Those jobs pull in different directions, and the
 * shapes below are chosen for the second one: a profile that fails validation
 * is thrown away, so the schema must be strict enough that a hallucinated or
 * half-formed answer cannot slip through, yet forgiving enough that a merely
 * untidy answer (an omitted empty array) is not treated as corruption.
 *
 * Collections are modelled as arrays of typed objects rather than string-keyed
 * records. A record with arbitrary keys is the shape most likely to be handled
 * badly by a provider's constrained-decoding implementation, and it gives us
 * no place to hang per-entry validation such as `url()`.
 *
 * `sources` is the anti-hallucination anchor: it is required and must be
 * non-empty. A model that invents a company wholesale tends to invent it
 * without citations, so "where did this come from" is the cheapest structural
 * check we have against fabricated profiles.
 */
import { z } from 'zod';

const nullableText = z.string().trim().nullable();
const nullableUrl = z.string().trim().url().nullable().catch(null);

export const ProductSchema = z.object({
  name: z.string().trim().min(1),
  description: nullableText,
  url: nullableUrl,
});

export const TeamMemberSchema = z.object({
  name: z.string().trim().min(1),
  role: nullableText,
  link: nullableUrl,
});

export const SocialLinkSchema = z.object({
  platform: z.string().trim().min(1),
  url: z.string().trim().url(),
});

export const BlogPostSchema = z.object({
  title: z.string().trim().min(1),
  url: z.string().trim().url(),
  // Publication dates appear in many formats and are not worth failing a whole
  // profile over; kept as free text and normalized only for display.
  date: nullableText,
});

export const ContactSchema = z.object({
  email: z.string().trim().email().nullable().catch(null),
  phone: nullableText,
  address: nullableText,
});

export const SectionSourceSchema = z.object({
  section: z.string().trim().min(1),
  urls: z.array(z.string().trim().url()).default([]),
});

export const CompanyProfileSchema = z.object({
  name: nullableText,
  tagline: nullableText,
  description: nullableText,
  products: z.array(ProductSchema).default([]),
  team: z.array(TeamMemberSchema).default([]),
  socials: z.array(SocialLinkSchema).default([]),
  pricingSummary: nullableText,
  blogPosts: z.array(BlogPostSchema).default([]),
  contact: ContactSchema.default({ email: null, phone: null, address: null }),
  sectionSources: z.array(SectionSourceSchema).default([]),
  sources: z.array(z.string().trim().url()).min(1),
});

export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type BlogPost = z.infer<typeof BlogPostSchema>;

export type CrawlStatus = 'complete' | 'partial';

/** What a finished job records about how the profile was produced. */
export interface ProfileProvenance {
  domain: string;
  crawledAt: string;
  crawlStatus: CrawlStatus;
  model: string;
}
