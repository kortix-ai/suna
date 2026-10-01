# Concepts

The ideas behind the words: the story Kortix tells, the house that holds the messages, the analogies
you may use, the manifesto, and why now. Read this when you write long-form (about page, blog, deck,
launch film, press, store description) or when a short line needs a reason behind it. For the lines
themselves, read `positioning.md`. For nouns, read `voice-and-tone.md`. For what you may claim, read
`claims.md`.

Every fact here traces to `MANIFESTO.md` and `README.md` at the repo root. Invent no metric, customer
or claim. Rule format: **Rule.** — *Why:* — *Where:* — *When silent:*.

## 1. The standing idea

A company is going to be a git repository. Not as a metaphor: something you can clone. Agents,
skills, memory, connectors, triggers and the definition of the machines all sit in one repo, as text.
A person reads it. An agent edits it. You can `grep` your whole company.

**Rule.** Lead long-form copy with the repo, not with the model. — *Why:* The model is a commodity that changes monthly. The repo is the part the customer owns, and it is the part no lab-hosted product offers. — *Where:* marketing | deck | blog | press. — *When silent:* ask "what does the reader keep?" and open with that.

## 2. The narrative arc

Six beats. Tell them in this order. Each beat ends where the next one starts.

1. **A company is a git repository.** A Kortix project is a git repo, and the repo is the company: configuration and accumulated state in one place, all text, all under version control, readable by a person and editable by an agent. `kortix.yaml` is the Kortix layer. The OpenCode config is the runtime the agents think in. Everything past that is files.
2. **It ships like code.** `kortix init` turns a directory into a Kortix. `kortix ship` checks that it compiles, asks for missing secrets, pushes it up and runs it. The repo behaves the same on your laptop and in the cloud.
3. **Work runs on cloud computers.** Start a session and a sandbox boots from one snapshot running the `kortix-sandbox-agent-server` daemon. It clones the repo, cuts a fresh branch and hands over a ready machine. The agent works walled off. When it wants to keep something, it commits and opens a change request toward `main`. A person decides whether it lands.
4. **It scales to a workforce.** Each session is its own sandbox on its own branch, so thousands can run in parallel without touching each other. The only shared thing is the world outside. The parallel, isolated workforce is the part that is hard to copy.
5. **It improves itself.** `main` is always up. Triggers fire in the night. An agent can edit its own configuration and propose the change, so the company files patches against itself.
6. **It feels easy.** Anyone can open it on day one from the web, a phone or a Slack thread. Most people never see `kortix.yaml`. Click a setting or edit a file: the change is identical.

**Rule.** Tell the arc in the order above and stop after the beats the audience needs. — *Why:* Each beat depends on the one before it. A deck that opens with "it scales" has no reader for why isolation matters. — *Where:* marketing | deck | blog. — *When silent:* developers get beats 1 to 3. Companies get 3, 4 and 6. Enterprise gets 3, 4 and the permission layer from `claims.md`.

**Rule.** Say how many parts there are, then show exactly that many. — *Why:* The security deck promised "four answers" and ran seven chapters. Rebuilding it to four did more for it than any visual work (kortix-presentation, "Structure discipline"). — *Where:* deck | marketing | docs. — *When silent:* cap at four named parts. A fifth idea goes on a marketing page.

**Rule.** Write beat 5 ("it improves itself") as a mechanism, never as a promise of autonomy. — *Why:* "Any agent can edit its own configuration and propose the change" is true. "The company runs itself" is not, because a person approves the change request. — *Where:* marketing | deck | press. — *When silent:* always include "a person approves".

## 3. The message house

- **Category:** AI Management System.
- **Roof (promise):** Run your whole company from one place you own: a workforce of AI agents that does real work.
- **Four pillars:**
  1. **Open and yours.** Open source and self-hostable. Your data, your models, your infrastructure. No lock-in, fully auditable.
  2. **A workforce, not one assistant.** Org-scale specialist agents run in parallel and compound a shared memory.
  3. **Real work, not chat.** Agents run on real cloud computers, return finished deliverables, and take real actions in your tools.
  4. **Everything is code.** Versioned, reviewable, portable, governable. Never a black box.
- **Foundation (proof):** the sanctioned proof points in `claims.md`. Nothing outside that list.

**Rule.** Hang every headline, subhead and caption on one pillar. — *Why:* A line that supports no pillar adds noise. A line that supports two pillars splits the reader's attention. — *Where:* marketing | deck | social | store listing. — *When silent:* name the pillar before you write. If you cannot, cut the line.

**Rule.** Do not add a fifth pillar and do not rename the four. — *Why:* The house is the shared frame. A fifth pillar breaks "four answers" and invites unreviewed claims. — *Where:* every surface. — *When silent:* put the new idea under the closest pillar as a proof point, after it passes `claims.md`.

**Rule.** Write the pillar names in sentence case with the period. — *Why:* They read as short declarative sentences ("Open and yours."). — *Where:* marketing | deck. — *When silent:* copy the string from this list.

### The three ways work runs

- **On demand:** ask in chat, get it now.
- **Human-assisted:** the agent works and checks in for the calls that matter.
- **Automated:** runs on a schedule or a trigger, end to end.

**Rule.** Name the three modes in this order and with these labels. — *Why:* They are the whole range of how a company uses agents, and the labels already appear in the store-listing brief. — *Where:* marketing | store listing | deck. — *When silent:* hyphenate "human-assisted"; keep "on demand" as two words without a hyphen when it is a noun phrase after "runs".

## 4. The concepts, one at a time

Three concepts have an approved metaphor. Use it only as stated. Every other concept takes the literal noun from the table in [voice-and-tone.md](voice-and-tone.md) section 3. Invent no new metaphor; propose it in `decisions.md` first. A metaphor beside a literal product noun in the same sentence confuses the noun.

| Concept | Approved metaphor | When to use it |
| --- | --- | --- |
| Project | "A company you can clone." | Intro, developer pitch. |
| Change request | "CI/CD, but for the work of an organization, not just its code." | Explaining governance and self-improvement. |
| Memory | "The living company brain." | Pillar 2. |

**Rule.** Use "a company you can clone", "CI/CD, but for the work of an organization, not just its code" and "the WordPress of AGI" as the only sanctioned analogies. Use at most one per paragraph. — *Why:* They come from the manifesto and the founder approved them. Stacked analogies blur the product. The "WordPress of AGI" line names one open core platform you own and extend; it is founder voice, so keep it out of category lines (D1). — *Where:* marketing | deck | social | press. — *When silent:* use none. State the mechanism instead.

**Rule.** Do not compare Kortix to a named product other than Claude Cowork and ChatGPT Work. — *Why:* The accuracy gate covers those two. Any other comparison needs a new fact check. — *Where:* marketing | social | blog. — *When silent:* describe the capability and drop the comparison.

## 5. The manifesto, in six moves

The full text is `MANIFESTO.md`. Use these moves when you write founder voice.

1. **The bet.** A company will be a git repository, and an AI-native company needs one place to run it from.
2. **The competition, honestly.** OpenAI, Anthropic and others will build a version of this. The difference is what you get and what you keep.
3. **A toy or a cage.** Single-tenant demos on one side. A lab that keeps your data, your configuration and your model on the other. Kortix refuses both.
4. **One company, one repo.** `kortix.yaml` plus the OpenCode config plus files. You can `grep` your company.
5. **It ships like code.** `kortix init`, `kortix ship`.
6. **The consequence.** Everything else falls out of taking both halves seriously: the repo and the single place to run it.

**Rule.** Write founder voice in the first person plural, in short declarative sentences, and name the stakes. — *Why:* The manifesto reads as a position, not a pitch. — *Where:* marketing (about, careers) | deck | social (founder account). — *When silent:* use "we" for the team and "you" for the reader. Do not write "I" unless the post is from a named founder account.

**Rule.** Keep "AGI" in founder voice (mission, manifesto, about). Keep it out of headlines, product names and meta text. — *Why:* D1 retires "open AGI platform" as a product line. — *Where:* marketing | store listing. — *When silent:* use "AI Management System".

## 6. Why now

Models reason well enough for real work. They still do not remember your company, isolate each task,
scope permissions or let you own the result. Running a real AI workforce is the unsolved part:
thousands of isolated cloud computers on one config, with reviewed work coming back to `main`.

**Rule.** State the problem as "a toy or a cage" and the answer as "the one you own". — *Why:* This is the manifesto's own framing (section 5, move 3), and it names the two real alternatives: a single-tenant demo, or a lab-hosted version that keeps your data, your configuration and your model. — *Where:* marketing | deck | social | press. — *When silent:* do not invent a third alternative. Name the lab-hosted option as the cage and the single-tenant demo as the toy.

**Rule.** Give "why now" as a state change in the market, never as a countdown or a fear. — *Why:* The claim is that a category now exists and lab-hosted versions ship it. No urgency needs inventing. — *Where:* marketing | deck | press. — *When silent:* "Agents that deliver finished work are now a product category."

**Rule.** Write the lab-hosted alternative as a fact about ownership, not as an attack. — *Why:* The comparison table already states the facts. Contempt adds nothing a reader can verify. — *Where:* marketing | blog | social. — *When silent:* "Their model, their cloud, your company on their side of the wall."
