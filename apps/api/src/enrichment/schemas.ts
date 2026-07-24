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
 *
 * A website's subject is not always a company. A personal portfolio forced
 * through a company-shaped schema has nowhere to put a bio or a project list,
 * so the model is left with almost nothing to fill in and the result reads as
 * a one-line profile. `subjectType` lets the model say what it is actually
 * looking at, and the schema below is the union of every shape a subject
 * might need: fields shared by any subject, a group that only makes sense for
 * a company, and a group that only makes sense for a person. A profile only
 * fills in the group that applies and leaves the other empty — the schema
 * does not enforce that split itself (a site can plausibly be both, e.g. a
 * founder's personal site that is also their company's home page), so both
 * groups stay simultaneously valid rather than mutually exclusive.
 *
 * Fields that predate subject detection keep their original strictness
 * (present, possibly null) so existing extraction output stays valid without
 * change. Every field added for subject detection instead defaults to empty
 * (`null` or `[]`) so a model — or a schema-shaped payload — that simply does
 * not know about a new field yet is untidy, not invalid.
 */
import { z } from 'zod';

const nullableText = z.string().trim().nullable();
// Same shape as `nullableText`, but the key itself may be omitted. Used only
// for fields introduced alongside subject detection, so old callers that
// don't know about them are not broken by their absence.
const optionalText = nullableText.default(null);
const nullableUrl = z.string().trim().url().nullable().catch(null);
const stringList = z.array(z.string().trim().min(1)).default([]);

export const SubjectTypeSchema = z.enum(['company', 'person', 'product', 'unknown']);

export const ProductSchema = z.object({
  name: z.string().trim().min(1),
  description: nullableText,
  url: nullableUrl,
  audience: optionalText,
});

export const TeamMemberSchema = z.object({
  name: z.string().trim().min(1),
  role: nullableText,
  link: nullableUrl,
  bio: optionalText,
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
  summary: optionalText,
  tags: stringList,
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

export const KeyFactSchema = z.object({
  label: z.string().trim().min(1),
  value: z.string().trim().min(1),
});

export const PricingTierSchema = z.object({
  name: z.string().trim().min(1),
  price: nullableText,
  cadence: nullableText,
  highlights: stringList,
  limits: nullableText,
});

export const PricingSchema = z.object({
  model: nullableText,
  currency: nullableText,
  // LLMs occasionally answer a yes/no question with a string; catching back
  // to null treats that as "unstated" rather than failing the whole profile.
  freeTier: z.boolean().nullable().catch(null),
  tiers: z.array(PricingTierSchema).default([]),
});

const EMPTY_PRICING = { model: null, currency: null, freeTier: null, tiers: [] };

export const CaseStudySchema = z.object({
  title: z.string().trim().min(1),
  client: nullableText,
  url: nullableUrl,
  summary: nullableText,
});

export const FaqItemSchema = z.object({
  question: z.string().trim().min(1),
  answer: z.string().trim().min(1),
});

export const RoleSchema = z.object({
  title: z.string().trim().min(1),
  org: nullableText,
  // Free text like `BlogPostSchema.date`, for the same reason: employment
  // dates appear as years, ranges, or "present", and normalizing them is a
  // display concern, not a validation one.
  start: nullableText,
  end: nullableText,
  summary: nullableText,
});

export const ProjectSchema = z.object({
  name: z.string().trim().min(1),
  url: nullableUrl,
  description: nullableText,
  tech: stringList,
});

export const CompanyProfileSchema = z.object({
  // A model that omits the field entirely has simply not made a call either
  // way, which is the same outcome as it explicitly answering "unknown" — so
  // omission defaults here rather than failing validation. An answer that
  // names a subject type outside the recognized set is a different failure
  // (the model inventing its own category) and is rejected, not defaulted.
  subjectType: SubjectTypeSchema.default('unknown'),

  // Shared — meaningful regardless of subject type.
  name: nullableText,
  tagline: nullableText,
  description: nullableText,
  socials: z.array(SocialLinkSchema).default([]),
  contact: ContactSchema.default({ email: null, phone: null, address: null }),
  blogPosts: z.array(BlogPostSchema).default([]),
  sectionSources: z.array(SectionSourceSchema).default([]),
  keyFacts: z.array(KeyFactSchema).default([]),
  sources: z.array(z.string().trim().url()).min(1),

  // Company-shaped. Left empty when the subject is not a company.
  positioning: optionalText,
  products: z.array(ProductSchema).default([]),
  pricingSummary: nullableText,
  pricing: PricingSchema.default(EMPTY_PRICING),
  team: z.array(TeamMemberSchema).default([]),
  integrations: stringList,
  techStack: stringList,
  caseStudies: z.array(CaseStudySchema).default([]),
  faq: z.array(FaqItemSchema).default([]),
  locations: stringList,
  founded: optionalText,

  // Person-shaped. Left empty when the subject is not a person.
  headline: optionalText,
  bio: optionalText,
  roles: z.array(RoleSchema).default([]),
  projects: z.array(ProjectSchema).default([]),
  writing: stringList,
  skills: stringList,
  speaking: stringList,
});

export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;
export type SubjectType = z.infer<typeof SubjectTypeSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type BlogPost = z.infer<typeof BlogPostSchema>;
export type KeyFact = z.infer<typeof KeyFactSchema>;
export type Pricing = z.infer<typeof PricingSchema>;
export type PricingTier = z.infer<typeof PricingTierSchema>;
export type CaseStudy = z.infer<typeof CaseStudySchema>;
export type FaqItem = z.infer<typeof FaqItemSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type Project = z.infer<typeof ProjectSchema>;

export type CrawlStatus = 'complete' | 'partial';

/** What a finished job records about how the profile was produced. */
export interface ProfileProvenance {
  domain: string;
  crawledAt: string;
  crawlStatus: CrawlStatus;
  model: string;
}
