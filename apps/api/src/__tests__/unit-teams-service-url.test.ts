import { describe, expect, test } from 'bun:test';
import { assertValidTeamsServiceUrl } from '../services/channels/teams-service-url';

// Every outbound Teams call carries the bot connector token. A host an outsider
// can register must never pass: the list accepted `*.azurewebsites.net` until
// 2026-09-28, and the upload route took `service_url` from the request body, so
// a caller with connector-write could have the managed bot's token sent to a
// host of their own.

describe('assertValidTeamsServiceUrl', () => {
  test('accepts the Teams connector and Bot Framework hosts', () => {
    for (const url of [
      'https://smba.trafficmanager.net/emea/',
      'https://smba.trafficmanager.net/amer/v3/conversations/a/activities',
      'https://europe.botframework.com/v3/conversations/x',
      'https://token.botframework.us/x',
    ]) {
      expect(assertValidTeamsServiceUrl(url)?.hostname).toBeTruthy();
    }
  });

  test('refuses hosts any Azure customer can register', () => {
    for (const url of [
      'https://attacker.azurewebsites.net/v3/conversations/x/activities',
      'https://smba.azurewebsites.net/',
      'https://someones-profile.trafficmanager.net/emea/',
    ]) {
      expect(assertValidTeamsServiceUrl(url)).toBeNull();
    }
  });

  test('refuses look-alikes, plain http and garbage', () => {
    for (const url of [
      'https://botframework.com.attacker.example/x',
      'https://evilbotframework.com/x',
      'http://smba.trafficmanager.net/emea/',
      'not a url',
      '',
    ]) {
      expect(assertValidTeamsServiceUrl(url)).toBeNull();
    }
  });
});
