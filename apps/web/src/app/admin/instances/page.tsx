import { redirect } from 'next/navigation';

export default function AdminInstancesRedirectPage() {
  redirect('/admin/ops');
}
