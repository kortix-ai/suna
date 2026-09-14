// Generated from the connectors user-visible UI catalog.
export const CONNECTORS_TRANSLATION_KEYS: Readonly<Record<string, string>> = {
  '3,000+ apps · MCP · OpenAPI · GraphQL · raw HTTP': 'textbe2dc4d42749',
  '3,000+ apps, OAuth handled': 'text5145b39c830f',
  '3,000+ connected': 'text27691018adc6',
  'A connector belongs to the project, not to a laptop or a login. Add it once and every session that project starts can reach it — with no second setup and no key passed around in a DM.':
    'text8bb2b50055b6',
  'A connector lives in one project. Another project cannot see it, call it, or read its credential — a project is its own blast radius.':
    'text08fc52a618da',
  'A drawer of keys in the agent’s environment': 'text4a77be626bd1',
  'A gate that errors out teaches an agent to retry around it. A Kortix gate holds the call open, so the agent is still mid-task when you answer — and picks up exactly where it stopped.':
    'textc87684446059',
  'A hash of the arguments, and a redacted result — never a raw secret.': 'text5ef80ac814da',
  'A sandbox is a real Linux machine the model can run anything on. So we do not put your credentials in it. The sandbox carries exactly one Kortix token, scoped to the project, and every outbound call is assembled on our side of the wall.':
    'text17ca81a2d026',
  'A tool left on Default has no rule of its own and falls through to the project default. Until you set that default to risk — reads run, writes and destructive actions ask — an untouched project runs everything.':
    'text8ddf68018449',
  'A tool-name rule can only ask “may the agent send email?” — which is rarely the question. A condition points at a value inside the call and matches it with a glob or a regular expression, so a rule can allow sending to your own domain and stop at everything else. A list argument passes only when every entry passes, so one off-list recipient is enough to hold the call. Anything the rule cannot decide resolves toward less access, never more.':
    'texteaf72e534b81',
  'Acted by': 'textcb0c5cea1bd5',
  Action: 'text64cff1319d2f',
  Allow: 'texte213c161d5ce',
  'Allow, ask, or block': 'textb5b66f95fd41',
  'Allow, Ask, or Block on every action, with a human in the loop where it matters.':
    'text3082aa227f95',
  always: 'text9cdc6c47aa19',
  'An approval stops the run. It does not fail it.': 'text696f36645979',
  'anything else': 'text6206bbb231e0',
  'API keys': 'text98aae8972102',
  'Approved by': 'text8e838c460986',
  Apps: 'text89dd748442c1',
  Ask: 'textb8c209cdead6',
  Audit: 'textbb6aea287396',
  Block: 'text211d0bb8cf4f',
  Channels: 'text4c8906cf76f5',
  'Choose who the connection belongs to: one project-managed account everyone shares, or a personal authorization where each member acts as themselves and an automated principal cannot act at all.':
    'text0c056ad641d1',
  'Client secrets': 'text422a9c2f3b55',
  'Connect a tool once, for the whole company. Agents reach it through one scoped token that Kortix brokers server-side — so the raw credential never lands in the machine the model is driving.':
    'text58aede554b21',
  'Connect once': 'text926cd23cff57',
  'Connect the first one in a minute.': 'text9ae2faa5b263',
  'Connector credentials are encrypted with a per-project key and stored apart from the values a sandbox is allowed to read.':
    'texteb17bf5059eb',
  'Connector keys stay server-side': 'text86e3b86877d0',
  Connectors: 'textc3d2e79ebdd0',
  'Connectors → Add app → Easy connect. Real screen, real project.': 'text6f301991f6d7',
  'Credentials encrypted, brokered server-side, never handed to the model.': 'textdacd5f120ffe',
  Custom: 'text494ca78f7374',
  'Custom APIs': 'text5f1a6dcd508e',
  'Decide what runs, what asks, and what never happens.': 'text02ed7e74d223',
  'Each agent lists the connectors it may use. The support agent reaches Zendesk and Gmail; the reporting agent reaches neither, and cannot discover that they exist.':
    'text33ed06dda991',
  'Easy connect': 'text429ffbbaa586',
  'Encrypted at rest': 'textd5169f4c999c',
  'Every action a connector exposes gets one of three answers, and you set them. One tool at a time, or one pattern that covers a hundred — a glob by default, or a regular expression when you wrap it in slashes.':
    'textf6981b3fc3f5',
  'Every call it made, and who let it.': 'text0a9977c04a4c',
  'Every key sits in the environment the model reads from. Revoking one means rotating it everywhere it was copied, and any of them can end up in a log line.':
    'textc32fad631f59',
  'Every tool your company runs on. None of the keys.': 'text33e39fbadab5',
  'Get started': 'text61e8d44ad423',
  'gmail.list_messages': 'textbbc3c635e57a',
  'gmail.send_email': 'text83536ce31c42',
  'Grants are text in the repo, so a change to who can reach what is a diff someone reviews — not a setting that quietly moved.':
    'text378214869b2f',
  'How Kortix does it': 'text8290912ebade',
  'Injected at call time': 'textd952c0d7b0b0',
  Inputs: 'text7abc49dfa87b',
  Keys: 'textf0d66a79c138',
  'Kortix brokers': 'texte4a461e463b6',
  'kortix.yaml': 'text1965f383021e',
  'MCP · OpenAPI · GraphQL · HTTP': 'text37aa35bdafc9',
  'Never crosses into the sandbox': 'textda2481d22696',
  'Never enter the machine': 'textba021a1745ad',
  'Never runs': 'text9432ea9b7e09',
  'OAuth access tokens': 'textfe2db5690c6e',
  'One connection. Every agent, every session, every person.': 'text1b602e7270b7',
  'One scoped token, and nothing else': 'texte0661dab3f98',
  'Open source and self-hostable — Kortix Cloud, your VPC, or on-prem.': 'texta6e6f5c3b55b',
  Outcome: 'text4e80abb5b146',
  'Pauses for a human': 'text8932a840affb',
  'Per agent': 'text79b8817235ae',
  'Per person': 'text6c6874dfe7ec',
  'Per project': 'text1d9c7125d64e',
  'Permissions on a real Google Drive connector — 51 tools, one answer each.': 'text52111885153a',
  'Pick the app, click through its OAuth screen, done. Kortix stores the connection, not your password — Gmail, Notion, Linear, Salesforce, HubSpot, Zendesk, Google Drive and thousands more.':
    'textf57829f4ec88',
  'Point Kortix at an OpenAPI or Postman spec, a GraphQL endpoint, a remote MCP server, or a bare HTTP base URL. It reads the source, works out the authentication, and turns every operation into a tool.':
    'textde8b3da50590',
  Policy: 'textc611981fab98',
  'Project-wide rules are evaluated first and cannot be overridden by whoever adds a connector later.':
    'textb69c0515beff',
  'Ran, denied, waiting on approval, or errored.': 'text4518e8b34f66',
  'Reach is granted, not inherited. An agent gets the connectors you list for it and nothing else, and effective access is always the intersection of what the person can do and what the agent was granted.':
    'textb35d7c2e59b8',
  'Read the docs': 'text559b1cc46027',
  'Read the trail for any session inside the app. Audit access is part of Enterprise.':
    'text11a432e7c5dd',
  'Refresh tokens': 'text4ca57b697d2f',
  Risk: 'text0711a8d636e4',
  'Rules that read the arguments, not just the tool name': 'text31d70af6b303',
  'Runs on its own': 'text6bf8684cc2aa',
  Scope: 'textb073f6c68ef8',
  'Scoped to one project and narrowed again by what that agent is allowed to touch. Turning a connector off takes effect on the next call. Nothing in the sandbox needs rotating, because nothing in the sandbox was ever a secret of yours.':
    'text8f6e69f092b0',
  'Slack and email connect the same way, so an agent can be reached and can reply where the work already happens.':
    'texte0401ccff09d',
  'Start free, connect a tool, and watch the first approval gate stop an agent mid-run. Self-host it if you would rather the whole thing lived in your own environment.':
    'text656db1b39511',
  'stripe.delete_customer': 'text6ada30b23e0e',
  'Talk to sales': 'textcfd0b0225710',
  'The action is not available, and no approval can lift it in the moment. Deleting a customer stays off the table.':
    'textf3561ba67553',
  'The agent and the person or trigger behind the session.': 'textdef49a469e2f',
  'The agent asks': 'texte8cd6188411a',
  'The agent calls a tool. It names the connector and the action — it has no URL, no host, no key.':
    'textbef9d0c36db1',
  'The agent drafts the reply and reaches send_email.': 'textd78ffa71af82',
  'The agent gets a token. It never gets the key.': 'text4634beebd84d',
  'The API answers': 'textd060b29cf17b',
  'The call goes straight through. For reads and for the routine writes you have already decided you trust.':
    'text1af17ebb39e4',
  'The call is held. You see the action and its arguments.': 'text16f918df0840',
  'The connector and the exact action called.': 'text248f3bad646d',
  'The credential never travels': 'texte6b19d06833d',
  'The gateway checks this agent may use this connector, resolves the policy, decrypts the credential server-side, and attaches it to the outbound request.':
    'text1635b720b911',
  'The gateway that resolves the credential is also the thing that writes the record. There is no path to a connected tool that skips it.':
    'text40c42e206ab5',
  'The Kortix connector catalogue, showing Notion, Google Sheets, Linear, Google Drive, Salesforce, HubSpot, GitHub, Gmail and more, each one click from connected.':
    'text0845712d2765',
  'The model is never shown a credential, and the ledger stores a hash of the inputs rather than the inputs themselves.':
    'text1d8b64ea50d6',
  'The pause is real': 'text09e97a9d16b8',
  'The Permissions tab of the Google Drive connector in Kortix: a default rule, then every Drive tool set to Allow, Ask, Block or Default.':
    'text169a667df8ce',
  'The places people already talk': 'texte7729b26fba3',
  'The run stops at the call and waits. A person approves it once, approves it for the rest of the session, or denies it.':
    'text5474fde32b76',
  'The same connector, readable by one agent and invisible to another.': 'text41089bf34bc8',
  'The secret is attached to one outbound request and thrown away. It is never written into the sandbox environment.':
    'text862cd97912b2',
  'The third-party API sees a normal authenticated request. The response comes back to the agent. The credential stays behind.':
    'text6eb71babbac4',
  'The usual way': 'text42117ed2a1f5',
  'to ends with @acme.com': 'text4c6882e7da5c',
  'Whether the action reads, writes, or destroys.': 'text036f65fb488b',
  'Who released a held call, and when.': 'text3d68ab225844',
  'You approve. The same call completes and the run continues.': 'text7f5e806ff554',
  'Your own APIs, in the same shape': 'text70db34eb02c8',
};
