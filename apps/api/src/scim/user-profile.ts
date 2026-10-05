import type { DirectoryUser } from './directory-users';

export const ENTERPRISE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const enterprisePrefix = ENTERPRISE_USER_SCHEMA.toLowerCase();
const dictionary = <T>(values: Record<string, T>): Record<string, T> => Object.assign(Object.create(null), values);
const scalars: Record<string, string> = dictionary(Object.fromEntries([
  'displayName', 'title', 'preferredLanguage', 'locale', 'timezone', 'nickName', 'profileUrl', 'userType',
].map(name => [name.toLowerCase(), name])));
const nameFields: Record<string, string> = dictionary(Object.fromEntries([
  'givenName', 'familyName', 'formatted', 'middleName', 'honorificPrefix', 'honorificSuffix',
].map(name => [name.toLowerCase(), name])));
const enterpriseFields: Record<string, string> = dictionary(Object.fromEntries([
  'employeeNumber', 'costCenter', 'organization', 'division', 'department',
].map(name => [name.toLowerCase(), name])));
const collections = dictionary<{ name: string; fields: Record<string, string> }>({
  emails: { name: 'emails', fields: { value: 'value', type: 'type', primary: 'primary', display: 'display' } },
  phonenumbers: { name: 'phoneNumbers', fields: { value: 'value', type: 'type', primary: 'primary', display: 'display' } },
  addresses: { name: 'addresses', fields: { type: 'type', primary: 'primary', formatted: 'formatted', streetaddress: 'streetAddress', locality: 'locality', region: 'region', postalcode: 'postalCode', country: 'country' } },
});
for (const collection of Object.values(collections)) collection.fields = dictionary(collection.fields);
const filteredPath = /^(emails|phonenumbers|addresses)\[type\s+eq\s+"([^"]+)"\](?:\.(\w+))?$/i;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nested(target: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!object(target[key])) target[key] = {};
  return target[key] as Record<string, unknown>;
}

function entries(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(object) : [];
}

function fieldValue(field: string, value: unknown) {
  if (value !== null && typeof value !== (field === 'primary' ? 'boolean' : 'string')) {
    throw new Error(`${field} has an invalid type`);
  }
}

class UserChanges extends Map<string, unknown> {
  readonly operations: Array<{ key: string; value: unknown; op: string }> = [];
}

export function userChanges(body: Record<string, unknown>, patch = false): Map<string, unknown> {
  const changes = new UserChanges();
  let currentOp = 'replace';
  const set = (key: string, value: unknown, remove = false) => {
    const attr = key.toLowerCase();
    if (['schemas', 'id', 'meta', 'groups'].includes(attr)) return;
    const filtered = attr.match(filteredPath);
    const enterprise = attr.startsWith(`${enterprisePrefix}:`) ? attr.slice(enterprisePrefix.length + 1) : null;
    const name = attr.startsWith('name.') ? attr.slice(5) : null;
    const managerField = enterprise?.startsWith('manager.') ? enterprise.slice(8) : null;
    const known = ['active', 'username', 'externalid', 'name', enterprisePrefix].includes(attr)
      || !!scalars[attr] || !!collections[attr] || (name !== null && !!nameFields[name])
      || (enterprise !== null && (!!enterpriseFields[enterprise] || enterprise === 'manager'))
      || (managerField !== null && ['value', 'displayname', '$ref'].includes(managerField))
      || (filtered !== null && (!filtered[3] || !!collections[filtered[1]!]!.fields[filtered[3]]));
    if (!known) throw new Error(`Unsupported user attribute: ${key}`);
    if (remove && ['active', 'username'].includes(attr)) throw new Error(`Cannot remove user attribute: ${key}`);
    if (remove) value = null;
    if (attr === 'active') {
      if (typeof value === 'string' && /^(true|false)$/i.test(value)) value = value.toLowerCase() === 'true';
      if (typeof value !== 'boolean') throw new Error('active must be a boolean');
    } else if (attr === 'username') {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 255) throw new Error('userName must contain 1 to 255 characters');
    } else if (attr === 'name' || attr === enterprisePrefix || enterprise === 'manager') {
      if (value !== null) {
        if (!object(value)) throw new Error(`${key} must be an attribute object`);
        for (const [sub, field] of Object.entries(value)) set(`${key}${attr === enterprisePrefix ? ':' : '.'}${sub}`, field);
        return;
      }
    } else if (collections[attr]) {
      if (value !== null) {
        if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
        value = value.map(item => {
          if (!object(item)) throw new Error(`${key} requires attribute objects`);
          const normalized: Record<string, unknown> = {};
          for (const [sub, field] of Object.entries(item)) {
            const canonical = collections[attr]!.fields[sub.toLowerCase()];
            if (!canonical) throw new Error(`Unsupported ${key} attribute: ${sub}`);
            fieldValue(canonical, field);
            normalized[canonical] = field;
          }
          if (attr !== 'addresses' && typeof normalized.value !== 'string') throw new Error(`${key} requires string values`);
          return normalized;
        });
      }
    } else if (filtered && !filtered[3]) {
      if (!remove) throw new Error('A filtered update requires a subattribute');
    } else {
      fieldValue(filtered?.[3] ?? attr, value);
    }
    changes.delete(attr);
    changes.set(attr, value);
    changes.operations.push({ key: attr, value, op: currentOp });
  };
  if (!object(body)) throw new Error('User must be an attribute object');
  if (patch) {
    if (!Array.isArray(body.Operations) || !body.Operations.length) throw new Error('Operations must be a nonempty array');
    for (const operation of body.Operations) {
      if (!object(operation)) throw new Error('Invalid PATCH operation');
      const op = typeof operation.op === 'string' ? operation.op.toLowerCase() : '';
      if (!['replace', 'add', 'remove'].includes(op)) throw new Error('Unsupported user PATCH operation');
      currentOp = op;
      if (typeof operation.path === 'string' && operation.path) set(operation.path, operation.value, op === 'remove');
      else if (operation.path === undefined && op !== 'remove' && object(operation.value)) {
        for (const [key, value] of Object.entries(operation.value)) set(key, value);
      } else throw new Error('A pathless PATCH operation requires an attribute object');
    }
  } else {
    for (const [key, value] of Object.entries(body)) set(key, value);
  }
  return changes;
}

export function applyProfile(user: DirectoryUser, changes: Map<string, unknown>): DirectoryUser {
  const profile = structuredClone(user.profile);
  const assign = (target: Record<string, unknown>, key: string, value: unknown) => {
    if (value === null) delete target[key];
    else target[key] = value;
  };
  const operations = changes instanceof UserChanges ? changes.operations : [...changes].map(([key, value]) => ({ key, value, op: 'replace' }));
  for (const { key, value, op } of operations) {
    const filtered = key.match(filteredPath);
    if (scalars[key]) assign(profile, scalars[key]!, value);
    else if (key === 'name') assign(profile, 'name', value);
    else if (key.startsWith('name.')) {
      assign(nested(profile, 'name'), nameFields[key.slice(5)]!, value);
    } else if (collections[key]) {
      const name = collections[key]!.name;
      profile[name] = op === 'add' && Array.isArray(value) ? [...entries(profile[name]), ...value] : value ?? [];
    } else if (filtered) {
      const collection = collections[filtered[1]!]!;
      const items = entries(profile[collection.name]);
      const match = (item: Record<string, unknown>) => typeof item.type === 'string' && item.type.toLowerCase() === filtered[2];
      if (!filtered[3]) profile[collection.name] = items.filter(item => !match(item));
      else {
        let item = items.find(match);
        if (!item && value !== null) items.push(item = { type: filtered[2] });
        if (item) assign(item, collection.fields[filtered[3]]!, value);
        profile[collection.name] = items;
      }
    } else if (key === enterprisePrefix) assign(profile, ENTERPRISE_USER_SCHEMA, value);
    else if (key.startsWith(`${enterprisePrefix}:`)) {
      const sub = key.slice(enterprisePrefix.length + 1);
      const extension = nested(profile, ENTERPRISE_USER_SCHEMA);
      if (sub.startsWith('manager.')) {
        assign(nested(extension, 'manager'), sub.slice(8) === 'displayname' ? 'displayName' : sub.slice(8), value);
      } else assign(extension, sub === 'manager' ? 'manager' : enterpriseFields[sub]!, value);
    }
  }
  return {
    ...user, profile,
    userName: changes.has('username') ? (changes.get('username') as string).trim().toLowerCase() : user.userName,
    externalId: changes.has('externalid') ? changes.get('externalid') as string | null : user.externalId,
  };
}
