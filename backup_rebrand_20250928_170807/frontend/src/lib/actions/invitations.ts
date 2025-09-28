'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '../supabase/server';
import { redirect } from 'next/navigation';

export async function createInvitation(
  prevState: any,
  formData: FormData,
): Promise<{ token?: string; message?: string }> {
  const invitationType = formData.get('invitationType') as string;
  const accountId = formData.get('accountId') as string;
  const accountRole = formData.get('accountRole') as string;

  const supabase = await createClient();

  const { data, error } = await supabase.rpc('create_invitation', {
    account_id: accountId,
    invitation_type: invitationType,
    account_role: accountRole,
  });

  if (error) {
    return {
      message: error.message,
    };
  }

  revalidatePath(`/[accountSlug]/settings/members/page`);

  return {
    token: data.token as string,
  };
}

export async function deleteInvitation(prevState: any, formData: FormData) {
  const invitationId = formData.get('invitationId') as string;
  const returnPath = formData.get('returnPath') as string;

  const supabase = await createClient();

  const { error } = await supabase.rpc('delete_invitation', {
    invitation_id: invitationId,
  });

  if (error) {
    return {
      message: error.message,
    };
  }
  redirect(returnPath);
}

export async function acceptInvitation(prevState: any, formData: FormData) {
  const token = formData.get('token') as string;

  const supabase = await createClient();

  const { error, data } = await supabase.rpc('accept_invitation', {
    lookup_invitation_token: token,
  });

  if (error) {
    return {
      message: error.message,
    };
  }
  redirect(`/${data.slug}`);
}
