// A line seal after Alfred's (assets/Seal.astro): a ring ornament around the
// standard's name. Used by the landing trust band and the security page.

export type Ornament = 'double' | 'ticks' | 'stars';

function ring(count: number, r: number) {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 - Math.PI / 2;
    return { x: 50 + Math.cos(a) * r, y: 50 + Math.sin(a) * r };
  });
}

function star(x: number, y: number, s: number) {
  return Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? s * 0.45 : s;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    return `${x + Math.cos(a) * r},${y + Math.sin(a) * r}`;
  }).join(' ');
}

/** A line seal after Alfred's: a ring ornament around the standard's name. */
export function Seal({
  name,
  detail,
  note,
  ornament,
  className = 'text-foreground size-32 lg:size-36',
}: {
  name: string;
  detail: string;
  note?: string;
  ornament: Ornament;
  /** Ink and size; the default sits on the page surface. */
  className?: string;
}) {
  return (
    <svg viewBox="0 0 100 100" className={className} role="img" aria-label={[name, detail, note].filter(Boolean).join(' ')}>
      <g fill="none" stroke="currentColor" strokeWidth="1">
        <circle cx="50" cy="50" r="48" />
        {ornament === 'double' && <circle cx="50" cy="50" r="44" strokeDasharray="1 2.5" />}
        {ornament === 'ticks' &&
          ring(48, 43).map((p, i) => (
            <line key={i} x1={p.x} y1={p.y} x2={50 + (p.x - 50) * 0.93} y2={50 + (p.y - 50) * 0.93} />
          ))}
        {ornament === 'stars' &&
          ring(12, 40).map((p, i) => (
            <polygon key={i} points={star(p.x, p.y, 3.2)} fill="currentColor" stroke="none" />
          ))}
      </g>
      <text x="50" y={note ? 47 : 52} textAnchor="middle" fontSize="17" fontWeight="500" fill="currentColor">
        {name}
      </text>
      <text x="50" y={note ? 61 : 66} textAnchor="middle" fontSize="10" fill="currentColor" opacity="0.75">
        {detail}
      </text>
      {note ? (
        <text x="50" y="73" textAnchor="middle" fontSize="9" fill="currentColor" opacity="0.75">
          {note}
        </text>
      ) : null}
    </svg>
  );
}
