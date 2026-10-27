const PLATE = '/media/landing/plate-config.svg';

// A real manifest: every key is in docs/project/manifest.mdx. Triggers are
// keyed by `slug` (the board said `name`, which the schema rejects).
const KORTIX_YAML = `kortix_version: 2
default_agent: kortix

agents:
  kortix:
    file: agents/kortix.md
    connectors: all
    skills: all

triggers:
  - slug: weekly-report
    type: cron
    agent: kortix
    cron: "0 0 8 * * 1"
    timezone: UTC`;

const FACTS = [
  { label: 'Version every change', tag: 'Git' },
  { label: 'Roll back in one commit', tag: 'Revert' },
  { label: 'Any model, your keys', tag: 'BYOK' },
];

/**
 * Config as code, Paper "Kortix 2" EBU-0: a bordered two-pane band. Left, the
 * claim and three facts on hairlines; right, a sand plate under the
 * kortix.yaml that runs the company.
 */
export function ConfigAsCode() {
  return (
    <section id="config-as-code" className="px-4 py-24 lg:py-35">
      <div className="mx-auto flex max-w-326 flex-col border lg:flex-row">
        <div className="flex flex-col justify-between gap-12 border-b p-8 lg:w-136 lg:shrink-0 lg:border-r lg:border-b-0 lg:p-13">
          <div className="flex flex-col gap-5">
            <p className="text-muted-foreground font-mono text-xs uppercase">Config as code</p>
            <h2 className="text-foreground text-4xl font-semibold tracking-tight text-balance lg:text-[44px] lg:leading-none">
              One file describes your whole company.
            </h2>
            <p className="text-muted-foreground text-base leading-relaxed text-pretty">
              Agents, their permissions, triggers and secrets live in kortix.yaml. Review a change
              to how your company works the same way you review code.
            </p>
          </div>

          <ul className="border-b">
            {FACTS.map((fact) => (
              <li key={fact.tag} className="flex items-center justify-between border-t py-3.75">
                <span className="text-foreground text-sm">{fact.label}</span>
                <span className="text-muted-foreground font-mono text-xs uppercase">
                  {fact.tag}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-card relative flex min-w-0 flex-1 items-center justify-center overflow-hidden px-4 py-12 lg:h-168 lg:py-0">
          <div
            aria-hidden
            className="bg-foreground absolute top-0 left-0 -translate-y-10 opacity-30"
            style={{ width: 700, height: 700, maskImage: `url(${PLATE})`, maskSize: '100% 100%' }}
          />
          <figure className="bg-background relative w-full max-w-152 overflow-hidden rounded-lg border shadow-lg">
            <div aria-hidden className="flex border-b font-mono text-xs">
              <span className="text-foreground border-foreground -mb-px border-r border-b px-4.5 py-2.5">
                kortix.yaml
              </span>
              <span className="text-muted-foreground px-4.5 py-2.5">agents/kortix.md</span>
            </div>
            <figcaption className="sr-only">kortix.yaml</figcaption>
            <pre className="text-foreground overflow-x-auto px-6 py-5.5 font-mono text-xs leading-6">
              <code>{KORTIX_YAML}</code>
            </pre>
          </figure>
        </div>
      </div>
    </section>
  );
}
