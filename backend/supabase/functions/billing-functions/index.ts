import {serve} from "https://deno.land/std@0.168.0/http/server.ts";
import {stripeFunctionHandler} from "https://deno.land/x/basejump@v2.0.3/billing-functions/mod.ts";
import { requireAuthorizedBillingUser } from "https://deno.land/x/basejump@v2.0.3/billing-functions/src/require-authorized-billing-user.ts";
import getBillingStatus from "https://deno.land/x/basejump@v2.0.3/billing-functions/src/wrappers/get-billing-status.ts";
import createSupabaseServiceClient from "https://deno.land/x/basejump@v2.0.3/billing-functions/lib/create-supabase-service-client.ts";
import validateUrl from "https://deno.land/x/basejump@v2.0.3/billing-functions/lib/validate-url.ts";

import Stripe from "https://esm.sh/stripe@11.1.0?target=deno";

console.log("Starting billing functions...");

const defaultAllowedHost = Deno.env.get("ALLOWED_HOST") || "http://localhost:3000";
const allowedHosts = [defaultAllowedHost, "https://www.suna.so", "https://suna.so", "https://staging.suna.so"];
console.log("Default allowed host:", defaultAllowedHost);

export const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
  };

console.log("Initializing Stripe client...");
const stripeClient = new Stripe(Deno.env.get("STRIPE_API_KEY") as string, {
    // This is needed to use the Fetch API rather than relying on the Node http
    // package.
    apiVersion: "2022-11-15",
    httpClient: Stripe.createFetchHttpClient(),
});
console.log("Stripe client initialized");

console.log("Setting up stripe handler...");
const stripeHandler = stripeFunctionHandler({
    stripeClient,
    defaultPlanId: Deno.env.get("STRIPE_DEFAULT_PLAN_ID") as string,
    defaultTrialDays: Deno.env.get("STRIPE_DEFAULT_TRIAL_DAYS") ? Number(Deno.env.get("STRIPE_DEFAULT_TRIAL_DAYS")) : undefined
});
console.log("Stripe handler configured");

serve(async (req) => {
    console.log("Received request:", req.method, req.url);
    
    if (req.method === "OPTIONS") {
        console.log("Handling OPTIONS request");
        return new Response("ok", {headers: corsHeaders});
    }
    
    try {
        const body = await req.json();
        console.log("Request body:", body);
        
        if (!body.args?.account_id) {
            console.log("Missing account_id in request");
            return new Response(
                JSON.stringify({ error: "Account id is required" }),
                {
                    status: 400,
                    headers: {
                        ...corsHeaders,
                        "Content-Type": "application/json"
                    }
                }
            );
        }

        switch (body.action) {
            case "get_plans":
                console.log("Getting plans");
                try {
                    const plans = await stripeHandler.getPlans(body.args);
                    console.log("Plans retrieved:", plans.length);
                    return new Response(
                        JSON.stringify(plans), 
                        {
                            headers: {
                                ...corsHeaders,
                                "Content-Type": "application/json",
                            },
                        }
                    );
                } catch (e) {
                    console.log("Error getting plans:", e);
                    return new Response(
                        JSON.stringify({ error: "Failed to get plans" }),
                        {
                            status: 500,
                            headers: {
                                ...corsHeaders,
                                "Content-Type": "application/json"
                            }
                        }
                    );
                }

            case "get_billing_portal_url":
                console.log("Getting billing portal URL for account:", body.args.account_id);
                if (!validateUrl(body.args.return_url, allowedHosts)) {
                    console.log("Invalid return URL:", body.args.return_url);
                    return new Response(
                        JSON.stringify({ error: "Return url is not allowed" }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                "Content-Type": "application/json"
                            }
                        }
                    );
                }
                
                return await requireAuthorizedBillingUser(req, {
                    accountId: body.args.account_id,
                    authorizedRoles: ["owner"],
                    async onBillableAndAuthorized(roleInfo) {
                        console.log("User authorized for billing portal, role info:", roleInfo);
                        try {
                            const response = await stripeHandler.getBillingPortalUrl({
                                accountId: roleInfo.account_id,
                                subscriptionId: roleInfo.billing_subscription_id,
                                customerId: roleInfo.billing_customer_id,
                                returnUrl: body.args.return_url,
                            });
                            console.log("Billing portal URL generated");
                            
                            return new Response(
                                JSON.stringify({
                                    billing_enabled: roleInfo.billing_enabled,
                                    ...response,
                                }),
                                {
                                    headers: {
                                        ...corsHeaders,
                                        "Content-Type": "application/json",
                                    },
                                }
                            );
                        } catch (e) {
                            console.log("Error getting billing portal URL:", e);
                            return new Response(
                                JSON.stringify({ error: "Failed to generate billing portal URL" }),
                                {
                                    status: 500,
                                    headers: {
                                        ...corsHeaders,
                                        "Content-Type": "application/json"
                                    }
                                }
                            );
                        }
                    },
                });

            case "get_new_subscription_url":
                console.log("Getting new subscription URL for account:", body.args.account_id);
                if (!validateUrl(body.args.success_url, allowedHosts) || !validateUrl(body.args.cancel_url, allowedHosts)) {
                    console.log("Invalid success or cancel URL:", body.args.success_url, body.args.cancel_url);
                    return new Response(
                        JSON.stringify({ error: "Success or cancel url is not allowed" }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                "Content-Type": "application/json"
                            }
                        }
                    );
                }
                
                return await requireAuthorizedBillingUser(req, {
                    accountId: body.args.account_id,
                    authorizedRoles: ["owner"],
                    async onBillableAndAuthorized(roleInfo) {
                        console.log("User authorized for new subscription, role info:", roleInfo);
                        try {
                            const response = await stripeHandler.getNewSubscriptionUrl({
                                accountId: roleInfo.account_id,
                                planId: body.args.plan_id,
                                successUrl: body.args.success_url,
                                cancelUrl: body.args.cancel_url,
                                billingEmail: roleInfo.billing_email,
                                customerId: roleInfo.billing_customer_id,
                            });
                            console.log("New subscription URL generated");
                            
                            return new Response(
                                JSON.stringify({
                                    billing_enabled: roleInfo.billing_enabled,
                                    ...response,
                                }),
                                {
                                    headers: {
                                        ...corsHeaders,
                                        "Content-Type": "application/json",
                                    },
                                }
                            );
                        } catch (e) {
                            console.log("Error getting new subscription URL:", e);
                            return new Response(
                                JSON.stringify({ error: "Failed to generate new subscription URL" }),
                                {
                                    status: 500,
                                    headers: {
                                        ...corsHeaders,
                                        "Content-Type": "application/json"
                                    }
                                }
                            );
                        }
                    },
                });

            case "get_billing_status":
                console.log("Getting billing status for account:", body.args.account_id);
                return await requireAuthorizedBillingUser(req, {
                    accountId: body.args.account_id,
                    authorizedRoles: ["owner"],
                    async onBillableAndAuthorized(roleInfo) {
                        console.log("User authorized, role info:", roleInfo);
                        const supabaseClient = createSupabaseServiceClient();
                        console.log("Getting billing status...");
                        try {
                            const response = await getBillingStatus(
                                supabaseClient,
                                roleInfo,
                                stripeHandler
                            );
                            console.log("Billing status response:", response);

                            return new Response(
                                JSON.stringify({
                                    ...response,
                                    status: response.status || "not_setup",
                                    billing_enabled: roleInfo.billing_enabled,
                                }),
                                {
                                    headers: {
                                        ...corsHeaders,
                                        "Content-Type": "application/json",
                                    },
                                }
                            );
                        } catch (e) {
                            console.log("Error getting billing status:", e);
                            return new Response(
                                JSON.stringify({ error: "Internal server error" }),
                                {
                                    status: 500,
                                    headers: {
                                        ...corsHeaders,
                                        "Content-Type": "application/json"
                                    }
                                }
                            );
                        }
                    },
                });

            default:
                console.log("Invalid action requested:", body.action);
                return new Response(
                    JSON.stringify({ error: "Invalid action" }),
                    {
                        status: 400,
                        headers: {
                            ...corsHeaders,
                            "Content-Type": "application/json"
                        }
                    }
                );
        }
    } catch (e) {
        console.log("Error processing request:", e);
        return new Response(
            JSON.stringify({ error: "Internal server error" }),
            {
                status: 500,
                headers: {
                    ...corsHeaders,
                    "Content-Type": "application/json"
                }
            }
        );
    }
});
