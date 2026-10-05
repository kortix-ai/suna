// Generated from the agent-automation user-visible UI catalog.
export const AGENT_AUTOMATION_TRANSLATION_KEYS: Readonly<Record<string, string>> = {
  '': 'texte3b0c44298fc',
  '1 session  =  1 computer  =  1 branch': 'text5d24939e8b83',
  '3,000+ apps in a click, plus MCP, OpenAPI, GraphQL and raw HTTP, reached through one scoped token brokered outside the machine.':
    'text831d4863e879',
  '6-field cron, any IANA timezone': 'text29306928fdc1',
  'A 6-field cron expression — second, minute, hour, day, month, weekday — in any IANA timezone. Or a single run_at timestamp, for something that should happen once and then stay quiet.':
    'text289b30b31ca1',
  'A burst queues, it does not drop': 'text79e4d7b87c05',
  'A filter is a dotted path matched against the same payload the prompt sees. It exists to break loops: a source that reports both sides of a conversation would otherwise fire the agent on its own reply.':
    'text1f23d8400f20',
  'A fresh branch is cut': 'text8ba5fa59166b',
  'A fresh fire boots its own isolated machine on its own branch, the same as a session you start by hand. Nothing it installs or breaks touches another session.':
    'text7e814a7424ef',
  'A Linux machine boots from the sandbox image your project declares. It is its own isolated machine: its own filesystem, its own process table, its own network. Nothing is shared with another session.':
    'text1459df2e344c',
  'A project runs 3 triggered sessions provisioning at once by default. A fire past that limit comes back queued and runs when a slot frees, rather than failing.':
    'textaa4a0d0b5235',
  'A project-level pause stops every trigger at once, on top of each trigger’s own enabled flag. Use it when the same repo runs on two control planes so nothing fires twice.':
    'text16f1f6b56a4a',
  'A prompt renders {{ token.dotted.path }} against the payload that fired it. A webhook fire gets {{ body.* }} and the request headers; a cron fire gets {{ cron.schedule }}, {{ cron.timezone }} and {{ cron.scheduled_for }}. A value that is not there renders as nothing — no error, no leftover braces in the message your agent reads.':
    'text73a37f05730d',
  'A runtime secret reaches a session only through the intersection of the agent’s declared grant and the role of the person who started it. Once delivered it is a real environment value, because that is how a tool uses it — we would rather say so than call it invisible.':
    'text355c7b7999a2',
  'A schedule you can read in one column.': 'textccf78bdeb35c',
  'A session starts. A machine boots.': 'textc730d5a71283',
  'A trigger is a block of YAML in the repo. Who added the 3am job, when, and what it was told to say are all in the log — the same as any other change.':
    'text614bf48e0bc8',
  'A trigger is a clock or a signature. Everything else about it — which agent it runs as, what it says, which session it lands in — is the same config either way.':
    'text2b3a113da6b7',
  'A trigger names an agent, and inherits exactly that agent’s grants — the connectors, secrets and skills its block in kortix.yaml lists, and nothing else. An agent with no grants gets no access.':
    'text0cd1e319b6e2',
  'A trigger starts a session with no person present. A cron schedule fires it on the clock; a signed webhook fires it on an event. Either way the agent gets its own cloud computer, its own branch, and the same review on the way back.':
    'text78c0df311db5',
  'A trigger stores an IANA timezone name, not an offset, and defaults to UTC. Set America/Los_Angeles and it stays at 09:00 local across a daylight-saving change. An abbreviation like PST is rejected rather than guessed at.':
    'text0602544ab665',
  'A triggered session is visible to the whole project, not private to whoever configured the trigger. It stops itself after 5 minutes idle, so an automation that runs at 3am is not a machine billing until morning.':
    'text42be5a22d7c8',
  'Agent computer': 'texta62359767c2b',
  'Agent harness': 'textb6a85bd3fbfe',
  'An agent rewriting its own prompt shows up the same way a code change does: a commit, on a branch, in a change request someone reads.':
    'text9ada0e627aed',
  'An agent you name': 'texte9e3243084ee',
  'An automation gets no privileges a person would not get. The same isolation, the same scoped reach, the same one road back to main.':
    'textac57cd102037',
  'An automation is a file, not a dashboard setting.': 'text0befde5f2be6',
  'An external service POSTs to the trigger URL. Kortix checks the signature, renders the payload into the prompt, and starts the session. A payload that fails your filter is accepted and ignored.':
    'textdd80c157b521',
  'and every other session you start, each on its own machine': 'textb4518309c8a3',
  'Automate it': 'textb63bc1453631',
  Automations: 'textad1fb9ec0cb3',
  'Boot sequence': 'textb538bf414362',
  'Boots with': 'textd6766fccffec',
  'Both are entries in kortix.yaml, so both have a history and an author.': 'text8b50c9763ebf',
  'Both carry a prompt template that becomes the session’s first message.': 'text003569c8b673',
  'Both types name the agent they run as, and inherit that agent’s deny-by-default reach.':
    'textbefd6c156056',
  'By default every fire is a clean slate. When the work is a running thread rather than a fresh errand, a trigger can re-prompt a session it already owns. Kortix tries the modes in order and falls through on failure, so a fire never simply disappears.':
    'textab4962ab35a6',
  'change request': 'textb6e3ca291ec2',
  'Change request to main': 'text895615cd8ca9',
  'Change the image the way you change any other file: in a change request.': 'text1a7e64092334',
  'Choose the tools and resources each agent needs once. Every new session uses that setup automatically.':
    'text1e5fdfe01184',
  'Connectors brokered server-side': 'textd346ad20b6da',
  'cron and webhook': 'textf7f35f36f425',
  'Cut a new branch and boot a new cloud computer. This is the default, and the last resort for every other mode.':
    'text1e271231e679',
  'daily-digest': 'textd6c3e87ae49c',
  'Declared in the repo': 'textab986ad2d8e6',
  discarded: 'text1fcc4b37141c',
  'draft three launch threads': 'texte17b809a23df',
  'Each agent works separately, so one session cannot interfere with another.': 'text0445efc0310d',
  'Every change has a diff': 'text69b668998c22',
  'Every session gets its own computer.': 'textb711e0ff2f4f',
  'Every trigger in a project is one row: what it is called, when it fires, in whose timezone, as which agent, and which session that fire lands in. Nothing about it is hidden state you have to click into.':
    'texteb85b20ae0b0',
  'Every webhook trigger names a project secret that signs it. A trigger without one is rejected at validation — there is no unauthenticated webhook to forget to lock down later.':
    'textbeb1d90456ab',
  'Everything is files': 'text81c55672efb4',
  finance: 'texteab762a03fd9',
  fresh: 'textd098ab5e44b9',
  'Fridays at 17:00': 'textb1fa39a2b442',
  'Full control': 'textba819ccda692',
  'Get a computer': 'text04a356d4f19f',
  'grep your whole company.': 'textf9e0dab461a6',
  'HMAC-SHA256 over the raw request body, compared in constant time. The GitHub-compatible X-Hub-Signature-256 header works too, so a repo webhook needs no adapter.':
    'text2a980276b7fa',
  'HMAC-SHA256, no unsigned path': 'texta2ad39633fff',
  'how this company does a specific job': 'text5c3a9739ea8f',
  'Hundreds of thousands of computers. One main.': 'texte7a8f54503d5',
  'inside the agent computer': 'textbaf0b7ee73d4',
  'Install anything. Run anything. Break anything.': 'textf0d695f605ae',
  'invoice-sweep': 'text9b26149c6be8',
  Isolation: 'text45c4fc064e52',
  'It arrives ready': 'text9a59ae9e9030',
  'It fires at 3am. A person still decides.': 'textf425a50db981',
  'It fires on an event': 'text6a51f9d2f64a',
  'It fires on the clock': 'textab0081a7e089',
  'It gets its own computer': 'textbb60080faee9',
  'It is disposable': 'textacc500a98e73',
  'It keeps running': 'textcd4f8d39c171',
  'It runs as an agent': 'textc5990132d694',
  keyed: 'text78da267198b7',
  kortix: 'text388f7968512c',
  'kortix triggers': 'text19229283a276',
  'kortix.yaml': 'text1965f383021e',
  'Long work does not depend on your tab. Close the laptop and the machine keeps going; open the session tomorrow and the work is where the agent left it.':
    'textda47795dda68',
  main: 'text0d6e4079e367',
  'Mondays at 08:00': 'text531ed88376cf',
  'No such trigger, or it is disabled, or it is not a webhook trigger.': 'text5471c95037b9',
  'Nothing merges itself': 'text956d3b01e6ca',
  'Nothing on the machine is precious. A bad install, a wrong migration, a wiped directory — the machine goes away and takes it with it. Only what the agent commits survives.':
    'text59f4422556e6',
  'oncall-handoff': 'text224f87a75a67',
  'One image per project, or a named image per agent.': 'text0dc3abbcb173',
  'One machine per session': 'text6590dfdb580e',
  'One machine per session · Pre-configured · Nothing runs on your laptop': 'text7a04f383ef22',
  'one OpenCode agent per file': 'text18a59ffd5fa8',
  'One switch pauses everything': 'textfb2ab460e464',
  'Open source and self-hostable. Any model, your keys. Kortix Cloud, your own VPC, or fully on-prem.':
    'text1d9a8dde5629',
  'Open source, with support for any AI model. Use Kortix Cloud or run it on your own systems.':
    'text5b6a9e140d4b',
  OpenCode: 'text3af0e55ccc96',
  'OpenCode runs inside the machine as the agent harness, with your models, your tools and your secrets injected at runtime. The machine is ready. The agent begins.':
    'textc72f8df372cb',
  'OpenCode starts': 'textf3d82cf5fcc9',
  Overnight: 'texta6b86e26c48d',
  Parallelism: 'text69585fb8aa14',
  pinned: 'text3fab5c181bd2',
  planner: 'text244b84350614',
  'Re-prompt one exact session, named by id. If that session is gone or failed, fall through.':
    'text39558bb4e2ab',
  'Re-prompt the most recent healthy session this trigger created. A pinned trigger falls back here before falling further.':
    'text2a2235310daa',
  'Read the docs': 'text559b1cc46027',
  'Read the trigger docs': 'text5dc9f6914b94',
  'reconcile the july invoices': 'textee678d46f548',
  'Render a key from the payload, then re-prompt the most recent healthy session stamped with that exact key. One customer, one thread. It never falls through into another key’s session.':
    'textf7f7adbb0a6c',
  reuse: 'textd9c0d34144c1',
  'reviewed by a person, then merged': 'text2e3571a5c710',
  'rewrite the pricing page': 'text998685db4b68',
  'roadmap-review': 'text91919987e58f',
  'Run many agents at once without mixing up their work. You review every result before it joins your main project.':
    'textf68480496a83',
  running: 'textc071cf5f5ed6',
  'Runs as': 'textdc98511e6b34',
  'sandbox image, triggers, channels, connectors, secrets': 'text84a8a60f0a66',
  Schedule: 'textf4830a1dae29',
  'Session strategy': 'text1747233af590',
  'Sessions never share a filesystem, a process table, or a network namespace. On Kortix’s own Platinum compute the boundary is a Cloud Hypervisor microVM; Daytona and E2B are also supported, and we will tell you which one you are on.':
    'text05e646f156e2',
  'Signature and token both missing or wrong. Nothing runs.': 'textf83d7ceb0541',
  'Signature valid. The session fired, queued behind the concurrency limit, or deduped against a delivery Kortix already saw.':
    'texte2a5b5794be9',
  'Signed, or it does not fire.': 'textbdec5adcbac2',
  'Start a session': 'textb7a2eb97cb86',
  'Start a session. Get a computer.': 'texta992b3a3033d',
  support: 'texta18603086e5b',
  'Talk to us about enterprise': 'text6345deaa83cb',
  'The 1st of the month at 06:30': 'text797bfed2cccb',
  'The automation itself has a history': 'textf17660b6d284',
  'The company is clonable': 'textc4a32a06810b',
  'The cron surface': 'text5eae34fc9718',
  'The default image already carries the Kortix runtime layer.': 'text09761bceefe9',
  'The machine clones the project repo into /workspace. Your agents, skills, memory, connectors and triggers arrive with it, because all of them are files in that repo.':
    'texte26a38466159',
  'The machine comes up': 'textaf4350fd72f4',
  'The machine cuts a branch named after the session. Every edit, commit and stray file the session produces lives on that branch and nowhere else.':
    'textacacd9b479c4',
  'The machine is a file in your project.': 'text9c550d2fd742',
  'The prompt is a template': 'textcb729fc03088',
  'The repo clones': 'textb67535ab165d',
  'The repo is cloned, the tools are installed and the dependencies are resolved before the agent starts. There is no setup step, and no local machine is involved at any point.':
    'text2cce28c5cf83',
  'The repo is the company. Fork it, branch it, roll it back, or hand it to a new machine — the whole configuration comes with it.':
    'texted13dee8f1f7',
  'the runtime your agents think in': 'text16886514658f',
  'The Schedules screen is a picker — every few minutes, weekdays, every month, or once at a moment you choose. Raw cron is the escape hatch behind it, not the price of entry.':
    'text12f89c97fe94',
  'The secret named by secret_env has no value set. Fails loudly rather than firing unprotected.':
    'text2aae333f0d13',
  'the shortcuts everyone shares': 'textf7fb7869bcaa',
  'the tools you wrote yourself': 'textcdcdff6eb6db',
  'Timezones are real': 'textb67115bd8489',
  'triage the support backlog': 'text5be4d558ea11',
  'Triggers live in kortix.yaml next to your agents and sandbox images. Each one names its agent, its schedule or its secret, and the prompt template that becomes the session’s first message.':
    'textb3170ca6cfd0',
  'Two agents edited the same file? git has handled that for twenty years. It is a merge. Nothing reaches main without a person approving it.':
    'text34578302fe84',
  'Two gates on every secret': 'text3e5546a47f26',
  'Two types': 'text7b415e0e7f41',
  'Two types · Declared in kortix.yaml · Reviewed like everything else': 'text138e22ba8f29',
  'Two types. There is no third.': 'text4ac65dfbfd14',
  Types: 'texta5fc918683bf',
  'Valid, and deliberately skipped — the project is paused, or the payload did not match the trigger’s filter.':
    'textb35b814c0d1f',
  'Walled off by default.': 'textb34cf5ffb75b',
  'Webhook auth': 'textd938438f232e',
  Webhooks: 'text45808d75bf89',
  'Weekdays at 09:00': 'text3bfef86a58a9',
  'Which session a fire lands in.': 'text837988d39c32',
  'Work lands via': 'text230c0a4b3c33',
  'Work reaches main only through a change request a person reviews and approves. The machine can propose. A human decides.':
    'text4606994a6bbe',
  'Work reaches main only through a change request a person reviews and approves. You read the diff over coffee. The machine never had the last word.':
    'texta11894f9c85d',
  'Work that starts without anyone asking.': 'text90aa768f3864',
  'Write the schedule. Read the change request.': 'text904cdac178a7',
  'X-Kortix-Signature: sha256=<hmac>': 'texte6d103e79843',
  'You do not have to write cron': 'textaccfa007425f',
  'Your agent can use the tools it needs, just as it would on a regular computer.':
    'texte5b104783abd',
  'Your agents, instructions, and shared knowledge stay in files you can read, change, and track.':
    'textdc5c5b516771',
  'Your project and tools are ready from the start, so the agent can work without using your laptop.':
    'text4c07fb41dc84',
  'Your project, tools, and setup are ready before the agent begins.': 'text3242681b6564',
  'Your repo, tools, dependencies': 'text6e4b1d4137f6',
};
