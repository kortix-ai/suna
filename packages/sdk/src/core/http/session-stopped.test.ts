import { describe, expect, test } from 'bun:test';
import { noteSessionStopped, onSessionStopped } from './session-stopped';

describe('session stopped notice (05#1)', () => {
  test('a stop reaches every listener once, and an unsubscribed listener hears nothing', () => {
    const heard: string[] = [];
    const off = onSessionStopped((id) => heard.push(`a:${id}`));
    onSessionStopped((id) => heard.push(`b:${id}`));
    noteSessionStopped('s1');
    off();
    noteSessionStopped('s2');
    expect(heard).toEqual(['a:s1', 'b:s1', 'b:s2']);
  });

  test('a throwing listener does not stop the others', () => {
    const heard: string[] = [];
    onSessionStopped(() => {
      throw new Error('boom');
    });
    onSessionStopped((id) => heard.push(id));
    noteSessionStopped('s3');
    expect(heard).toEqual(['s3']);
  });
});
