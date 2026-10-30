import { describe, expect, test } from 'bun:test';
import { Fragment } from 'react';

import { childrenToText } from './children-text';

describe('childrenToText', () => {
  test('returns a plain string child unchanged', () => {
    expect(childrenToText('npm install\n')).toBe('npm install\n');
  });

  test('joins an array of string children', () => {
    expect(childrenToText(['a', 'b', 'c'])).toBe('abc');
  });

  // The regression: `wrapChildrenWithPaths` replaced the fence body with a
  // fragment, and `String(<Fragment/>)` is the literal `[object Object]`.
  test('reads the text back out of a wrapping element', () => {
    const wrapped = (
      <Fragment>
        {'cd ~/UnrealEngine\n'}
        <span>./Setup.sh</span>
        {'\nmake\n'}
      </Fragment>
    );

    expect(childrenToText(wrapped)).toBe('cd ~/UnrealEngine\n./Setup.sh\nmake\n');
    expect(childrenToText(wrapped)).not.toContain('[object Object]');
  });

  test('ignores nullish and boolean children', () => {
    expect(childrenToText([null, undefined, false, 'ok', true])).toBe('ok');
  });

  test('renders numeric children', () => {
    expect(childrenToText([1, '+', 2])).toBe('1+2');
  });

  test('returns an empty string for no children', () => {
    expect(childrenToText(undefined)).toBe('');
  });
});
