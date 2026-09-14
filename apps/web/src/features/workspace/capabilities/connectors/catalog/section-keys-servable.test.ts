/**
 * The catalogue page opened a section by asking the server for that section's
 * key. The keys were ours (curated buckets), the filter was the provider's
 * (its own category slugs), and where the two disagreed the request answered
 * zero — which the grid rendered as "Catalogue unavailable" over a catalogue
 * that had just painted.
 *
 * Measured against the live Composio catalogue on dev:
 *   category=email            -> 51     category=communication -> 30
 *   category=crm              -> 80     category=sales-marketing -> 0
 *   category=Other            -> 0
 * So `crm` folded into `sales-marketing` emptied the grid outright, and `email`
 * folded into `communication` quietly showed a different set than its heading
 * counted.
 */
import { expect, test } from 'bun:test';
import { OTHER, groupIntoSections, sectionKeysForEntry } from './connector-categories';

const entry = (categories: string[]) => ({ categories });

test('curated bucketing still folds provider categories together', () => {
  expect([...sectionKeysForEntry(['crm'])]).toEqual(['sales-marketing']);
  expect([...sectionKeysForEntry(['email'])]).toEqual(['communication']);
});

test('raw mode keeps the provider slug, which is the only key it can serve', () => {
  expect([...sectionKeysForEntry(['crm'], { raw: true })]).toEqual(['crm']);
  expect([...sectionKeysForEntry(['email'], { raw: true })]).toEqual(['email']);
  expect([...sectionKeysForEntry(['scheduling-&-booking'], { raw: true })]).toEqual([
    'scheduling-&-booking',
  ]);
});

test('an uncategorized entry still lands in the synthetic section, raw or not', () => {
  expect([...sectionKeysForEntry([], { raw: true })]).toEqual([OTHER]);
  expect([...sectionKeysForEntry(['   '], { raw: true })]).toEqual([OTHER]);
});

test('raw grouping produces one section per provider category, not per curated bucket', () => {
  const sections = groupIntoSections(
    [entry(['crm']), entry(['marketing']), entry(['email'])],
    (item) => item.categories,
    { raw: true },
  );
  expect(sections.map((section) => section.category).sort()).toEqual(['crm', 'email', 'marketing']);
});

test('the same input collapses to two curated buckets without raw', () => {
  const sections = groupIntoSections(
    [entry(['crm']), entry(['marketing']), entry(['email'])],
    (item) => item.categories,
  );
  expect(sections.map((section) => section.category).sort()).toEqual([
    'communication',
    'sales-marketing',
  ]);
});
