import { redirect } from 'next/navigation';

// The brand guidelines now live at /design-system (the living design system).
// Keep /brand working for any existing links.
export default function BrandRedirect() {
  redirect('/design-system');
}
