import { redirect } from 'next/navigation';

// The providers console moved to /admin/sandboxes (operators manage
// sandboxes; the provider is the implementation detail). Keep the old URL
// working for bookmarks and muscle memory.
export default function AdminProvidersRedirect() {
  redirect('/admin/sandboxes');
}
