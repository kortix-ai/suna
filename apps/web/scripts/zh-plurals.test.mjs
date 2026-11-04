import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { IntlMessageFormat } from 'intl-messageformat';

const catalog = JSON.parse(readFileSync(new URL('../translations/zh.json', import.meta.url), 'utf8'));
const categories = new Set(new Intl.PluralRules('zh').resolvedOptions().pluralCategories);
function check(elements, path) {
  for (const element of elements) {
    if (element.type === 6) {
      for (const [category, option] of Object.entries(element.options)) {
        assert.ok(category.startsWith('=') || categories.has(category), `${path}: unreachable ${category}`);
        check(option.value, path);
      }
    } else if (element.options) {
      for (const option of Object.values(element.options)) check(option.value, path);
    } else if (element.children) check(element.children, path);
  }
}
for (const [name, group] of Object.entries({ reminders: catalog.reminders, page: catalog.agentEditor.page, summaryCount: catalog.agentEditor.tabs.summaryCount, accessCount: catalog.agentEditor.tabs.accessCount })) {
  test(`Chinese ${name} count messages compile, format and use reachable cardinal branches`, () => {
    for (const [key, value] of Object.entries(group)) {
      if (typeof value !== 'string' || !value.includes(', plural,')) continue;
      const message = new IntlMessageFormat(value, 'zh');
      check(message.getAst(), `${name}.${key}`);
      for (const count of [0, 1, 2, 100]) {
        const output = message.format({ count, total: count, date: '2026-10-31' });
        assert.equal(typeof output, 'string');
        assert.ok(output.includes(String(count)), `${name}.${key}: count ${count}`);
      }
    }
  });
}
