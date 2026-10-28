// Rewrites the kortix.yaml key tables of the docs (the generated:kortix-yaml
// region) from the published v3 JSON Schema, so the reference cannot drift
// from what `kortix validate` and editors check. Every key, type, enum, bound,
// default and description comes from packages/manifest-schema/src/json-schema.ts
// (published as apps/web/public/schema/kortix.v3.schema.json). A key without a
// description fails the run: write the description there, not here.
//
//   bun apps/web/scripts/generate-kortix-yaml-doc.mjs [file]           # default apps/web/content/docs/developers.mdx
//   bun apps/web/scripts/generate-kortix-yaml-doc.mjs [file] --check
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cell, code, onByDefault, repositoryRoot, runRegionGenerator } from './docs-generated-region.mjs';

const SCRIPT = 'apps/web/scripts/generate-kortix-yaml-doc.mjs';
const schema = JSON.parse(readFileSync(resolve(repositoryRoot, 'apps/web/public/schema/kortix.v3.schema.json'), 'utf8'));
const root = schema.properties;

const orList = (items) => (items.length < 2 ? items[0] : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`);

/** The Type cell, read from the validation keywords. */
function typeOf(node) {
  if (node.const !== undefined) return code(node.const);
  const values = node.enum ?? node.anyOf?.find((alternative) => alternative.enum)?.enum;
  if (values) return values.filter((value) => value !== '').map(code).join(', ');
  const alternatives = node.type ? undefined : (node.oneOf ?? node.anyOf);
  if (alternatives) {
    if (alternatives.some((alternative) => alternative.anyOf?.some((arm) => arm.enum?.includes('none')))) return 'grant';
    return orList([...new Set(alternatives.map(typeOf))]);
  }
  const type = [node.type ?? node.allOf?.find((part) => part.type)?.type].flat()[0];
  if (type === 'object') return 'map';
  if (type === 'array') return 'list';
  if (type === 'integer' && node.minimum !== undefined) {
    return node.maximum === undefined ? `integer, ${node.minimum} or more` : `integer, ${node.minimum} to ${node.maximum}`;
  }
  return type;
}

/** Own properties plus those of each oneOf/anyOf/allOf branch. A described one wins. */
function propertiesOf(node) {
  const merged = { ...node.properties };
  for (const branch of [...(node.oneOf ?? []), ...(node.anyOf ?? []), ...(node.allOf ?? [])]) {
    for (const [name, child] of Object.entries(branch.properties ?? {})) {
      if (!(name in merged) || (!merged[name]?.description && child?.description)) merged[name] = child;
    }
  }
  return merged;
}

function row(key, node, required, table) {
  const described = node.description ?? '';
  if (!described) throw new Error(`${key} (${table.heading}) has no description in packages/manifest-schema/src/json-schema.ts`);
  const textDefault = /\s*Default: (.+)\.$/.exec(described);
  const type = table.types?.[key] ?? typeOf(node);
  if (!type) throw new Error(`${key} (${table.heading}) has no type: give it one in that table's types`);
  const fallback = node.default !== undefined ? code(node.default) : (textDefault?.[1] ?? '—');
  const description = [textDefault ? described.slice(0, textDefault.index) : described, table.see?.[key]].filter(Boolean).join(' ');
  return `| ${cell(code(key))} | ${cell(type)} | ${cell(required ? 'required' : fallback)} | ${cell(description)} |`;
}

/** One row per property of `node`; an `expand` key adds rows for its own properties. */
function rows(node, prefix, table) {
  const required = new Set([...(node.required ?? []), ...(node.then?.required ?? [])]);
  return Object.entries(propertiesOf(node)).flatMap(([name, child]) => {
    const key = prefix + name;
    if (child === false || child.deprecated || key in (table.skip ?? {})) return [];
    if (key in (table.flagged ?? {}) && !onByDefault(table.flagged[key])) return [];
    const own = row(key, child, required.has(name), table);
    if (!table.expand?.includes(key)) return [own];
    return [own, ...(child.type === 'array' ? rows(child.items, `${key}[].`, table) : rows(child, `${key}.`, table))];
  });
}

/** A registry map: the entry, its name rule, then the entry's own keys. */
function registryRows(key, table) {
  const node = root[key];
  const entry = `${key}.<name>`;
  return [
    row(entry, node.additionalProperties, false, table),
    row('<name>', { type: 'string', description: node.propertyNames.description }, false, table),
    ...rows(node.additionalProperties, `${entry}.`, table),
  ];
}

const agent = root.agents.additionalProperties;
const [flatTrigger, trigger] = root.triggers.items.anyOf;
const connector = root.connectors.items;
const connectorRule = connector.properties.policies.items.properties;
const app = root.apps.additionalProperties;

// Event triggers on connected apps need the `event_triggers` flag, off by default.
const eventTriggerKeys = ['connector', 'account', 'source', 'config'];
const triggerFlagged = Object.fromEntries(
  [...eventTriggerKeys.map((name) => `on.${name}`), ...eventTriggerKeys, 'event'].map((key) => [key, 'event_triggers']),
);

const TABLES = [
  {
    heading: '### Top-level keys',
    rows: (table) => rows(schema, '', table),
    see: {
      agents: 'See [Agent keys](#agent-keys).',
      imports: 'See [imports](#imports).',
      env: 'See [env keys](#env-keys).',
      sandbox: 'See [sandbox keys](#sandbox-keys).',
      skills: 'See [skills entries](#skills-entries).',
      tools: 'See [tools entries](#tools-entries).',
      commands: 'See [commands entries](#commands-entries).',
      extensions: 'See [extensions entries](#extensions-entries).',
      connectors: 'See [connectors keys](#connectors-keys) and [Connectors](/docs/#connectors).',
      apps: 'See [apps keys](#apps-keys).',
      triggers: 'See [triggers keys](#triggers-keys) and [Automations](/docs/#automations).',
      policy: 'See [policy keys](#policy-keys).',
      policies: 'See [policy keys](#policy-keys).',
      approvals: 'See [policy keys](#policy-keys).',
    },
  },
  {
    heading: '### Agent keys',
    rows: (table) => rows(agent, '', table),
    expand: ['workspace'],
    see: {
      model: 'See [Models](/docs/#models).',
      permission: 'See [Permission rules](#permission-rules).',
      policy_sets: 'See [Connector rules and approvals](#connector-rules-and-approvals).',
      kortix_permissions: 'See [Agents](/docs/#agents).',
    },
  },
  { heading: '### Registry entries' },
  { heading: '#### skills entries', rows: (table) => registryRows('skills', table) },
  { heading: '#### tools entries', rows: (table) => registryRows('tools', table) },
  { heading: '#### commands entries', rows: (table) => registryRows('commands', table) },
  { heading: '#### extensions entries', rows: (table) => registryRows('extensions', table), expand: ['extensions.<name>.pi'] },
  { heading: '### Section keys' },
  { heading: '#### env keys', rows: (table) => rows(root.env, 'env.', table) },
  {
    heading: '#### sandbox keys',
    rows: (table) => rows(root.sandbox, 'sandbox.', table),
    expand: ['sandbox.templates'],
    // `image` and `dockerfile` carry their type in the oneOf that makes them exclusive.
    types: { 'sandbox.templates[].image': 'string', 'sandbox.templates[].dockerfile': 'string' },
  },
  {
    heading: '#### triggers keys',
    rows: (table) => [
      ...rows(trigger, '', table),
      // The flat form: only the keys the `on`/`run` rows above do not already list.
      ...rows(
        {
          ...flatTrigger,
          required: [],
          properties: Object.fromEntries(
            Object.entries(flatTrigger.properties).filter(([name]) => !trigger.properties[name]),
          ),
        },
        '',
        table,
      ),
    ],
    expand: ['on', 'on.webhook', 'run'],
    flagged: triggerFlagged,
    // camelCase and older spellings the parser still accepts. Documented: the snake_case key.
    skip: Object.fromEntries(
      ['agent_name', 'prompt_template', 'schedule', 'runAt', 'secretEnv', 'sessionId', 'sessionKey', 'sessionMode'].map((key) => [key, 'alias']),
    ),
    types: {
      enabled: 'boolean',
      model: 'string',
      type: flatTrigger.properties.type.enum.filter((value) => value !== 'event' || onByDefault('event_triggers')).map(code).join(', '),
    },
  },
  {
    heading: '#### connectors keys',
    rows: (table) => rows(connector, '', table),
    expand: ['auth'],
    skip: {
      baseUrl: 'alias of base_url',
      // Kortix writes the channel connector and its platform when a channel is connected.
      platform: 'written by Kortix',
      // Only `shared` validates, which is what every connector already is.
      credential: 'no effect',
    },
    types: {
      enabled: 'boolean',
      sensitive: 'boolean',
      'auth.in': '`header`, `query`, `cookie`',
      'auth.name': 'string',
      'auth.prefix': 'string',
    },
  },
  {
    heading: '#### policy keys',
    rows: (table) => [
      ...rows(root.policy, 'policy.', table),
      ...rows(root.policies.items, 'policies[].', table),
      ...rows(root.approvals, 'approvals.', table),
    ],
    types: {
      'policy.default_mode': '`allow_all`, `risk`',
      // `kortix validate` does not check project rules; they take the connector rule's shape.
      ...Object.fromEntries(Object.entries(connectorRule).map(([name, node]) => [`policies[].${name}`, typeOf(node)])),
    },
  },
  {
    heading: '#### apps keys',
    rows: (table) => [
      row(
        'apps.<slug>',
        { ...app, description: `${app.description} Its keys: ${Object.keys(app.properties).map(code).join(', ')}.` },
        false,
        table,
      ),
    ],
    see: { 'apps.<slug>': 'Full reference: [Configure in kortix.yaml](/docs/#configure-in-kortixyaml).' },
  },
];

export function renderKortixYamlTables() {
  return [
    `{/* Generated by ${SCRIPT} from packages/manifest-schema/src/json-schema.ts. Edit the descriptions there, then run the script. */}`,
    ...TABLES.map((table) =>
      table.rows
        ? [table.heading, '', '| Key | Type | Default | Description |', '| --- | --- | --- | --- |', ...table.rows(table)].join('\n')
        : table.heading,
    ),
  ].join('\n\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await runRegionGenerator('kortix-yaml', SCRIPT, renderKortixYamlTables);
