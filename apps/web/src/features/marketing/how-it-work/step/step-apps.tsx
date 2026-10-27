// Sample data only: Northwind is the sample company, owners are numbers. One
// row carries the kortix-orange "needs attention" mark (color.md status table).
const PROPOSALS = [
  { name: 'Acme renewal', owner: 'Owner 1', stage: 'Signed', attention: false },
  { name: 'Globex expansion', owner: 'Owner 2', stage: 'Waiting on legal', attention: true },
  { name: 'Initech pilot', owner: 'Owner 3', stage: 'Draft', attention: false },
  { name: 'Umbrella onboarding', owner: 'Owner 1', stage: 'Sent', attention: false },
  { name: 'Hooli migration', owner: 'Owner 4', stage: 'Signed', attention: false },
];

/** An internal App as an agent ships it: its URL, then a live table. */
export function StepApps() {
  return (
    <div className="bg-background flex h-full w-full flex-col overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <span className="bg-muted size-2 rounded-full" />
        <span className="bg-muted size-2 rounded-full" />
        <span className="bg-muted size-2 rounded-full" />
        <span className="text-muted-foreground ml-2 truncate font-mono text-xs">proposals.northwind.app</span>
      </div>
      <div className="flex items-baseline justify-between px-4 pt-4">
        <p className="text-foreground text-sm font-medium">Open proposals</p>
        <p className="text-muted-foreground text-xs">Updated by an agent</p>
      </div>
      <ul className="mt-3 divide-y border-t">
        {PROPOSALS.map((row) => (
          <li
            key={row.name}
            className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 text-sm sm:grid-cols-[1fr_4.5rem_8rem]"
          >
            <span className="text-foreground truncate">{row.name}</span>
            <span className="text-muted-foreground hidden text-xs sm:block">{row.owner}</span>
            <span className="text-muted-foreground flex items-center gap-2 text-xs">
              {row.attention ? (
                <span className="bg-kortix-orange size-1.5 rounded-full" aria-label="Needs attention" />
              ) : null}
              {row.stage}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
