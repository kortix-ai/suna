import { test } from 'bun:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { IntlMessageFormat } from 'intl-messageformat';
test('localized session costs preserve plural arguments and render counts', () => {
for (const locale of ['zh','ja']) {
  const catalog=JSON.parse(readFileSync(`${import.meta.dir}/../translations/${locale}.json`,'utf8')).hardcodedUi.componentsSessionSessionContextModal;
  for (const key of ['costSplit','spawnedCount','spawnedHidden']) {
    const message=new IntlMessageFormat(catalog[key],locale);
    const ast=message.getAst();
    assert(ast.some(part=>part.type===6 && part.value==='count'),`${locale}.${key} must retain a plural count argument`);
    for (const count of [0,1,2]) assert.match(message.format({count,own:'$1',spawned:'$2'}),new RegExp(String(count)));
  }
}
});
