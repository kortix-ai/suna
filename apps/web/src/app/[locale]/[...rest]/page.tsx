import { notFound } from 'next/navigation';

// The root layout lives in app/[locale], so an unmatched path under a locale
// has no parent not-found boundary of its own. This catch-all routes it to
// app/[locale]/not-found.tsx inside the localized root layout.
export default function CatchAllNotFound(): never {
  notFound();
}
