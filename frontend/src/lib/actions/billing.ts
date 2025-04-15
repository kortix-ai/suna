"use server";

import { redirect } from "next/navigation";
import { createClient } from "../supabase/server";
import handleEdgeFunctionError from "../supabase/handle-edge-error";

export async function setupNewSubscription(prevState: any, formData: FormData) {
    const accountId = formData.get("accountId") as string;
    const returnUrl = formData.get("returnUrl") as string;
    const planId = formData.get("planId") as string;
    const supabaseClient = await createClient();

    const { data, error } = await supabaseClient.functions.invoke('billing-functions', {
        body: {
            action: "get_new_subscription_url",
            args: {
                account_id: accountId,
                success_url: returnUrl,
                cancel_url: returnUrl,
                plan_id: planId
            }
        }
    });

    if (error) {
        return await handleEdgeFunctionError(error);
    }

    redirect(data.url);
};

export async function manageSubscription(prevState: any, formData: FormData) {
    const accountId = formData.get("accountId") as string;
    const returnUrl = formData.get("returnUrl") as string;
    const supabaseClient = await createClient();

    const { data, error } = await supabaseClient.functions.invoke('billing-functions', {
        body: {
            action: "get_billing_portal_url",
            args: {
                account_id: accountId,
                return_url: returnUrl
            }
        }
    });

    console.log(data);
    
    if (error) {
        console.error(error);
        return await handleEdgeFunctionError(error);
    }

    redirect(data.url);
};