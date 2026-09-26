/**
 * GLSL reserves every identifier that contains two consecutive underscores
 * (GLSL ES 3.00 §3.8). ANGLE rejects the whole program when it sees one:
 *
 *   ERROR: 0:47: 'colorA__r_2h_' : identifiers containing two consecutive
 *   underscores (__) are reserved as possible future keywords
 *
 * `shaders` names each uniform `${propName}_${instanceId}`, and when a
 * component has no `id` prop the instance id is React's `useId()` with only
 * non-word characters stripped. React 19.2+ formats that id as `_r_2h_`, so
 * every uniform came out as `colorA__r_2h_`: the project-home wallpaper never
 * compiled and logged `useProgram: program not valid` ~20 times a second.
 *
 * `patches/shaders@2.5.135.patch` collapses runs of `_` in the uniform name.
 * This test drives the library's real `createUniformsMap` with a React 19.3
 * `useId()` value, so it fails again if the patch stops applying.
 */
import { describe, expect, test } from 'bun:test';
import { useId } from 'react';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';

import { createUniformsMap } from 'shaders/core';
import { componentDefinition as dither } from 'shaders/core/Dither';
import { componentDefinition as plasma } from 'shaders/core/Plasma';
import { componentDefinition as waveDistortion } from 'shaders/core/WaveDistortion';
import { componentDefinition as grain } from 'shaders/core/FilmGrain';

/** The instance id `shaders/react` derives when no `id` prop is passed. */
function libraryInstanceIdFor(reactId: string): string {
  return reactId.replace(/[^a-zA-Z0-9_]/g, '');
}

/** A real `useId()` value from the React this app ships. */
function realReactId(): string {
  let id = '';
  function Probe() {
    id = useId();
    return null;
  }
  renderToString(createElement(Probe));
  return id;
}

function uniformNames(definition: unknown, instanceId: string): string[] {
  // `shaders/react` fills every prop's `default` before building uniforms
  // (computeEffectiveProps); do the same so each prop's transform gets a value.
  const props = Object.fromEntries(
    Object.entries((definition as { props: Record<string, { default?: unknown }> }).props).map(
      ([key, config]) => [key, config.default],
    ),
  );
  const map = createUniformsMap(definition as never, props, instanceId) as Record<
    string,
    { uniform: { name: string } }
  >;
  return Object.values(map).map((entry) => entry.uniform.name);
}

describe('shaders uniform names', () => {
  test('React 19 ids start and end with an underscore — the trigger', () => {
    const id = realReactId();
    expect(id).toMatch(/^_.*_$/);
  });

  for (const [label, definition] of [
    ['Dither', dither],
    ['Plasma', plasma],
    ['WaveDistortion', waveDistortion],
    ['FilmGrain', grain],
  ] as const) {
    test(`${label}: no uniform name contains a reserved "__"`, () => {
      const names = uniformNames(definition, libraryInstanceIdFor(realReactId()));
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((name) => name.includes('__'))).toEqual([]);
    });
  }

  test('an explicit id with underscores is collapsed too', () => {
    const names = uniformNames(dither, 'wall__paper_');
    expect(names.filter((name) => name.includes('__'))).toEqual([]);
  });
});
