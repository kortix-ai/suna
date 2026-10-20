import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Security · Lumen' };

const SECTIONS = [
  {
    title: 'Your documents stay in your firm’s workspace',
    body: 'Each firm gets its own workspace. Documents, conversations and results belong to that workspace and are not visible to other firms.',
  },
  {
    title: 'Every task runs in its own isolated workspace',
    body: 'When Lumen reads documents or drafts a result, it does so in a separate, isolated environment created for that conversation or run.',
  },
  {
    title: 'No training on your data',
    body: 'This is the configured policy of this deployment: model routing is set to providers that do not train on submitted content. Ask your administrator for the current provider list.',
  },
  {
    title: 'Roles and restricted matters',
    body: 'Owners and admins manage members, billing and firm settings. Lawyers work in the matters they can see. A restricted matter is visible only to the people added to it, and to firm admins.',
  },
  {
    title: 'An audit log you cannot edit',
    body: 'Lumen records every change: members, roles, matters, conversations, exports and billing. Admins can filter and export it. There is no way to delete an entry.',
  },
  {
    title: 'What restricted matters do not do',
    body: 'Matters are separated by Lumen’s access control in the application. A walled matter, with its own isolated workspace for conflicts-sensitive work, is planned.',
  },
];

export default function SecurityPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
      <h1 className="font-display text-5xl tracking-tight">Security</h1>
      <p className="mt-3 text-muted-foreground">How Lumen handles your firm’s documents, in plain words. We make no claim here that we cannot back.</p>
      <div className="mt-12 space-y-10">
        {SECTIONS.map((s) => (
          <section key={s.title}>
            <h2 className="font-display text-2xl tracking-tight">{s.title}</h2>
            <p className="mt-2 leading-relaxed text-muted-foreground">{s.body}</p>
          </section>
        ))}
      </div>
      <p className="mt-16 border-t border-border pt-6 text-xs text-muted-foreground">Lumen is powered by Kortix.</p>
    </div>
  );
}
