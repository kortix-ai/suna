import { redirect } from 'next/navigation';

/**
 * Legacy file-browser route. Files now live as a section inside the
 * full-screen Customize modal — this redirect keeps existing bookmarks and
 * deep links working by jumping to /sessions and letting the modal auto-open
 * on the Files tab via the `?customize=files` search param.
 */
export default async function ProjectFilesRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/projects/${id}/customize?section=files`);
}
