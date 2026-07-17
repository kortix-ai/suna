import { describe, expect, test } from 'bun:test';
import { normalizePostmanDocuments } from '../executor/sync';

describe('Postman multi-document catalogs', () => {
  test('namespaces actions and deterministically suffixes collisions', () => {
    const openapi = (path: string) => ({
      openapi: '3.0.0',
      paths: { [path]: { get: { operationId: 'list', responses: {} } } },
    });
    const actions = normalizePostmanDocuments([
      { namespace: 'crm_contacts_v3', kind: 'openapi', source: 'contacts-a.json', doc: openapi('/contacts') },
      { namespace: 'crm_contacts_v3', kind: 'openapi', source: 'contacts-b.json', doc: openapi('/contacts/archive') },
      { namespace: 'crm_companies_v3', kind: 'openapi', source: 'companies.json', doc: openapi('/companies') },
    ]);

    expect(actions.map((action) => action.path)).toEqual([
      'crm_contacts_v3.list',
      'crm_contacts_v3.list_2',
      'crm_companies_v3.list',
    ]);
  });

  test('does not add a namespace to a single exported collection', () => {
    const actions = normalizePostmanDocuments([{
      namespace: 'hubspot',
      kind: 'postman',
      source: 'hubspot.postman_collection.json',
      doc: {
        info: { name: 'HubSpot', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [{ name: 'Get owner', request: { method: 'GET', url: 'https://api.hubapi.com/owners/v2/owners' } }],
      },
    }]);
    expect(actions.map((action) => action.path)).toEqual(['get_owner']);
  });
});
