import { describe, expect, test } from 'bun:test';
import { CompanyProfileSchema } from './schemas';

const SOURCES = ['https://example.com/', 'https://example.com/about'];

const COMPANY_PROFILE = {
  subjectType: 'company',
  name: 'Example Inc',
  tagline: 'We do things',
  description: 'Example Inc builds tools for teams.',
  socials: [{ platform: 'twitter', url: 'https://twitter.com/example' }],
  contact: { email: 'hi@example.com', phone: null, address: null },
  blogPosts: [
    {
      title: 'Launch',
      url: 'https://example.com/blog/launch',
      date: '2026-01-02',
      summary: 'We launched.',
      tags: ['launch', 'news'],
    },
  ],
  sectionSources: [{ section: 'team', urls: ['https://example.com/team'] }],
  keyFacts: [{ label: 'Founded', value: '2015' }],
  sources: SOURCES,
  positioning: 'The simplest way to ship widgets.',
  products: [{ name: 'Widget', description: 'A widget', url: 'https://example.com/widget', audience: 'SMBs' }],
  pricingSummary: 'Free tier plus paid plans.',
  pricing: {
    model: 'subscription',
    currency: 'USD',
    freeTier: true,
    tiers: [
      {
        name: 'Pro',
        price: '$49/mo',
        cadence: 'monthly',
        highlights: ['Unlimited widgets', 'Priority support'],
        limits: '10 seats',
      },
    ],
  },
  team: [{ name: 'Ada Lovelace', role: 'CEO', link: 'https://example.com/team/ada', bio: 'Founder.' }],
  integrations: ['Slack', 'Zapier'],
  techStack: ['TypeScript', 'Postgres'],
  caseStudies: [{ title: 'Acme scales up', client: 'Acme', url: 'https://example.com/case/acme', summary: 'Grew 10x.' }],
  faq: [{ question: 'Is there a free trial?', answer: 'Yes, 14 days.' }],
  locations: ['San Francisco, CA'],
  founded: '2015',
};

const PERSON_PROFILE = {
  subjectType: 'person',
  name: 'Ada Lovelace',
  tagline: null,
  description: null,
  socials: [{ platform: 'github', url: 'https://github.com/ada' }],
  contact: { email: 'ada@example.com', phone: null, address: null },
  pricingSummary: null,
  blogPosts: [],
  sectionSources: [],
  keyFacts: [{ label: 'Location', value: 'London' }],
  sources: SOURCES,
  headline: 'Mathematician and writer',
  bio: 'Ada writes about the analytical engine.',
  roles: [
    {
      title: 'Collaborator',
      org: 'Analytical Engine Project',
      start: '1842',
      end: '1843',
      summary: 'Wrote the first published algorithm.',
    },
  ],
  projects: [
    {
      name: 'Notes on the Analytical Engine',
      url: 'https://example.com/notes',
      description: 'An extended commentary.',
      tech: ['mathematics'],
    },
  ],
  writing: ['Notes on the Analytical Engine'],
  skills: ['mathematics', 'writing'],
  speaking: ['Royal Society lecture'],
};

describe('CompanyProfileSchema — subject detection', () => {
  test('a company profile validates', () => {
    const result = CompanyProfileSchema.safeParse(COMPANY_PROFILE);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.subjectType).toBe('company');
    expect(result.data.positioning).toBe('The simplest way to ship widgets.');
    expect(result.data.pricing.tiers[0].name).toBe('Pro');
    expect(result.data.products[0].audience).toBe('SMBs');
    expect(result.data.team[0].bio).toBe('Founder.');
    expect(result.data.keyFacts[0]).toEqual({ label: 'Founded', value: '2015' });
    expect(result.data.blogPosts[0].summary).toBe('We launched.');
    expect(result.data.blogPosts[0].tags).toEqual(['launch', 'news']);
  });

  test('a person profile validates', () => {
    const result = CompanyProfileSchema.safeParse(PERSON_PROFILE);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.subjectType).toBe('person');
    expect(result.data.headline).toBe('Mathematician and writer');
    expect(result.data.roles[0].title).toBe('Collaborator');
    expect(result.data.projects[0].name).toBe('Notes on the Analytical Engine');
    expect(result.data.skills).toEqual(['mathematics', 'writing']);
  });

  test('a profile with both company and person fields populated still validates', () => {
    const merged = { ...COMPANY_PROFILE, ...PERSON_PROFILE, subjectType: 'company' as const };
    const result = CompanyProfileSchema.safeParse(merged);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.products.length).toBeGreaterThan(0);
    expect(result.data.roles.length).toBeGreaterThan(0);
  });

  test('rejects empty sources', () => {
    const result = CompanyProfileSchema.safeParse({ ...COMPANY_PROFILE, sources: [] });
    expect(result.success).toBe(false);
  });

  test('rejects a subjectType outside the recognized set', () => {
    const result = CompanyProfileSchema.safeParse({ ...COMPANY_PROFILE, subjectType: 'nonprofit' });
    expect(result.success).toBe(false);
  });

  test('accepts the literal "unknown" subjectType', () => {
    const result = CompanyProfileSchema.safeParse({ ...COMPANY_PROFILE, subjectType: 'unknown' });
    expect(result.success).toBe(true);
  });

  test('defaults subjectType to "unknown" when the model omits it', () => {
    const { subjectType, ...withoutSubjectType } = COMPANY_PROFILE;
    const result = CompanyProfileSchema.safeParse(withoutSubjectType);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.subjectType).toBe('unknown');
  });

  test('optional collections default to [] when the model omits them', () => {
    const minimal = {
      subjectType: 'unknown',
      name: null,
      tagline: null,
      description: null,
      contact: { email: null, phone: null, address: null },
      pricingSummary: null,
      sources: SOURCES,
    };
    const result = CompanyProfileSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.socials).toEqual([]);
    expect(result.data.blogPosts).toEqual([]);
    expect(result.data.sectionSources).toEqual([]);
    expect(result.data.keyFacts).toEqual([]);
    expect(result.data.products).toEqual([]);
    expect(result.data.team).toEqual([]);
    expect(result.data.integrations).toEqual([]);
    expect(result.data.techStack).toEqual([]);
    expect(result.data.caseStudies).toEqual([]);
    expect(result.data.faq).toEqual([]);
    expect(result.data.locations).toEqual([]);
    expect(result.data.roles).toEqual([]);
    expect(result.data.projects).toEqual([]);
    expect(result.data.writing).toEqual([]);
    expect(result.data.skills).toEqual([]);
    expect(result.data.speaking).toEqual([]);
    expect(result.data.positioning).toBeNull();
    expect(result.data.founded).toBeNull();
    expect(result.data.headline).toBeNull();
    expect(result.data.bio).toBeNull();
    expect(result.data.pricing).toEqual({ model: null, currency: null, freeTier: null, tiers: [] });
  });

  test('defaults a product missing "audience" rather than rejecting it', () => {
    const result = CompanyProfileSchema.safeParse({
      ...COMPANY_PROFILE,
      products: [{ name: 'Widget', description: null, url: null }],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.products[0].audience).toBeNull();
  });

  test('defaults a team member missing "bio" rather than rejecting it', () => {
    const result = CompanyProfileSchema.safeParse({
      ...COMPANY_PROFILE,
      team: [{ name: 'Ada Lovelace', role: 'CEO', link: null }],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.team[0].bio).toBeNull();
  });

  test('rejects a case study missing a title', () => {
    const result = CompanyProfileSchema.safeParse({
      ...COMPANY_PROFILE,
      caseStudies: [{ title: '', client: null, url: null, summary: null }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects an faq entry missing an answer', () => {
    const result = CompanyProfileSchema.safeParse({
      ...COMPANY_PROFILE,
      faq: [{ question: 'Anything?', answer: '' }],
    });
    expect(result.success).toBe(false);
  });

  test('drops an invalid free-tier value rather than failing the profile', () => {
    const result = CompanyProfileSchema.safeParse({
      ...COMPANY_PROFILE,
      pricing: { ...COMPANY_PROFILE.pricing, freeTier: 'yes' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.pricing.freeTier).toBeNull();
  });
});
