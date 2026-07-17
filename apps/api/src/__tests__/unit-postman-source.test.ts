import { describe, expect, test } from 'bun:test';
import {
  parsePostmanApiEntity,
  parsePostmanApiIndex,
  resolvePostmanSource,
} from '../executor/postman-source';

describe('Postman repository metadata', () => {
  test('parses the repeated API ids from .postman/api', () => {
    expect(parsePostmanApiIndex(`
      apis[] = {"apiId":"alpha"}
      apis[] = {"apiId":"beta"}
      configVersion = 1.0.0
    `)).toEqual(['alpha', 'beta']);
  });

  test('prefers original OpenAPI definitions and retains collections as fallback', () => {
    expect(parsePostmanApiEntity(`
      [config.relations.collections]
      rootDirectory = PublicApiSpecs/CRM/Contacts/Collection Directory
      files[] = {"id":"1","path":"Contacts Collection.json","metaData":{}}
      [config.relations.apiDefinition]
      files[] = {"path":"PublicApiSpecs/CRM/Contacts/contacts.json","metaData":{}}
      [config.relations.apiDefinition.metaData]
      type = openapi:3
      rootFiles[] = PublicApiSpecs/CRM/Contacts/contacts.json
    `)).toEqual({
      type: 'openapi',
      files: ['PublicApiSpecs/CRM/Contacts/contacts.json'],
    });
  });

  test('resolves a GitHub Postman repository deterministically through raw files', async () => {
    const loaded: string[] = [];
    const documents = await resolvePostmanSource(
      'https://github.com/acme/apis',
      async (url) => {
        loaded.push(url);
        if (url.endsWith('/.postman/api')) return 'apis[] = {"apiId":"contacts"}\napis[] = {"apiId":"companies"}';
        if (url.endsWith('/.postman/api_contacts')) return '[config.relations.apiDefinition.metaData]\ntype = openapi:3\nrootFiles[] = specs/contacts.json';
        if (url.endsWith('/.postman/api_companies')) return '[config.relations.apiDefinition.metaData]\ntype = openapi:3\nrootFiles[] = specs/companies.json';
        if (url.endsWith('/specs/contacts.json')) return JSON.stringify({ openapi: '3.0.0', paths: { '/contacts': { get: { operationId: 'list' } } } });
        if (url.endsWith('/specs/companies.json')) return JSON.stringify({ openapi: '3.0.0', paths: { '/companies': { get: { operationId: 'list' } } } });
        throw new Error(`unexpected ${url}`);
      },
      { githubDefaultBranch: async () => 'main' },
    );

    expect(documents.map((doc) => [doc.namespace, doc.kind])).toEqual([
      ['specs_companies', 'openapi'],
      ['specs_contacts', 'openapi'],
    ]);
    expect(loaded[0]).toBe('https://raw.githubusercontent.com/acme/apis/main/.postman/api');
  });

  test('public Postman workspace URLs require supported API credentials', async () => {
    await expect(resolvePostmanSource(
      'https://www.postman.com/hubspot/hubspot-public-api-workspace/overview',
      async () => { throw new Error('must not scrape'); },
      {},
    )).rejects.toThrow('POSTMAN_API_KEY');
  });
});
