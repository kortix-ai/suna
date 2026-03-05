/**
  * -------------------------------------------------------
  * Section - Billing
  * -------------------------------------------------------
 */

/**
* Subscription Status
* Tracks the current status of the account subscription
*/
DO
$$
    BEGIN
        IF NOT EXISTS(SELECT 1
                      FROM pg_type t
                               JOIN pg_namespace n ON n.oid = t.typnamespace
                      WHERE t.typname = 'subscription_status'
                        AND n.nspname = 'basejump') THEN
            create type basejump.subscription_status as enum (
                'trialing',
                'active',
                'canceled',
                'incomplete',
                'incomplete_expired',
                'past_due',
                'unpaid'
                );
        end if;
    end;
$$;


/**
 * Billing customer
 * This is a private table that contains a mapping of user IDs to your billing providers IDs
 */
create table if not exists basejump.billing_customers
(
    -- UUID from auth.users
    account_id uuid references basejump.accounts (id) on delete cascade not null,
    -- The user's customer ID in Stripe. User must not be able to update this.
    id         text primary key,
    -- The email address the customer wants to use for invoicing
    email      text,
    -- The active status of a customer
    active     boolean,
    -- The billing provider the customer is using
    provider   text
);

-- Open up access to billing_customers
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE basejump.billing_customers TO service_role;
GRANT SELECT ON TABLE basejump.billing_customers TO authenticated;


-- enable RLS for billing_customers
alter table
    basejump.billing_customers
    enable row level security;

/**
  * Billing subscriptions
  * This is a private table that contains a mapping of account IDs to your billing providers subscription IDs
 */
create table if not exists basejump.billing_subscriptions
(
    -- Subscription ID from Stripe, e.g. sub_1234.
    id                   text primary key,
    account_id           uuid references basejump.accounts (id) on delete cascade          not null,
    billing_customer_id  text references basejump.billing_customers (id) on delete cascade not null,
    -- The status of the subscription object, one of subscription_status type above.
    status               basejump.subscription_status,
    -- Set of key-value pairs, used to store additional information about the object in a structured format.
    metadata             jsonb,
    -- ID of the price that created this subscription.
    price_id             text,
    plan_name            text,
    -- Quantity multiplied by the unit amount of the price creates the amount of the subscription. Can be used to charge multiple seats.
    quantity             integer,
    -- If true the subscription has been canceled by the user and will be deleted at the end of the billing period.
    cancel_at_period_end boolean,
    -- Time at which the subscription was created.
    created              timestamp with time zone default timezone('utc' :: text, now())   not null,
    -- Start of the current period that the subscription has been invoiced for.
    current_period_start timestamp with time zone default timezone('utc' :: text, now())   not null,
    -- End of the current period that the subscription has been invoiced for. At the end of this period, a new invoice will be created.
    current_period_end   timestamp with time zone default timezone('utc' :: text, now())   not null,
    -- If the subscription has ended, the timestamp of the date the subscription ended.
    ended_at             timestamp with time zone default timezone('utc' :: text, now()),
    -- A date in the future at which the subscription will automatically get canceled.
    cancel_at            timestamp with time zone default timezone('utc' :: text, now()),
    -- If the subscription has been canceled, the date of that cancellation. If the subscription was canceled with `cancel_at_period_end`, `canceled_at` will still reflect the date of the initial cancellation request, not the end of the subscription period when the subscription is automatically moved to a canceled state.
    canceled_at          timestamp with time zone default timezone('utc' :: text, now()),
    -- If the subscription has a trial, the beginning of that trial.
    trial_start          timestamp with time zone default timezone('utc' :: text, now()),
    -- If the subscription has a trial, the end of that trial.
    trial_end            timestamp with time zone default timezone('utc' :: text, now()),
    provider             text
);

-- Open up access to billing_subscriptions
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE basejump.billing_subscriptions TO service_role;
GRANT SELECT ON TABLE basejump.billing_subscriptions TO authenticated;

-- enable RLS for billing_subscriptions
alter table
    basejump.billing_subscriptions
    enable row level security;

/**
  * -------------------------
  * Section - RLS Policies
  * -------------------------
  * This is where we define access to tables in the basejump schema
 */

create policy "Can only view own billing customer data." on basejump.billing_customers for
    select
    using (
    basejump.has_role_on_account(account_id) = true
    );


create policy "Can only view own billing subscription data." on basejump.billing_subscriptions for
    select
    using (
    basejump.has_role_on_account(account_id) = true
    );

/**
  * -------------------------------------------------------
  * Section - Public functions
  * -------------------------------------------------------
  * Each of these functions exists in the public name space because they are accessible
  * via the API.  it is the primary way developers can interact with Basejump accounts
 */


/**
  * Returns the current billing status for an account
 */
CREATE OR REPLACE FUNCTION public.get_account_billing_status(account_id uuid)
    RETURNS jsonb
    security definer
    set search_path = public, basejump
AS
$$
DECLARE
    result      jsonb;
    role_result jsonb;
BEGIN
    select public.current_user_account_role(get_account_billing_status.account_id) into role_result;

    select jsonb_build_object(
                   'account_id', get_account_billing_status.account_id,
                   'billing_subscription_id', s.id,
                   'billing_enabled', case
                                          when a.personal_account = true then config.enable_personal_account_billing
                                          else config.enable_team_account_billing end,
                   'billing_status', s.status,
                   'billing_customer_id', c.id,
                   'billing_provider', config.billing_provider,
                   'billing_email',
                   coalesce(c.email, u.email) -- if we don't have a customer email, use the user's email as a fallback
               )
    into result
    from basejump.accounts a
             join auth.users u on u.id = a.primary_owner_user_id
             left join basejump.billing_subscriptions s on s.account_id = a.id
             left join basejump.billing_customers c on c.account_id = coalesce(s.account_id, a.id)
             join basejump.config config on true
    where a.id = get_account_billing_status.account_id
    order by s.created desc
    limit 1;

    return result || role_result;
END;
$$ LANGUAGE plpgsql;

grant execute on function public.get_account_billing_status(uuid) to authenticated;

/**
  * Allow service accounts to upsert the billing data for an account
 */
CREATE OR REPLACE FUNCTION public.service_role_upsert_customer_subscription(account_id uuid,
                                                                            customer jsonb default null,
                                                                            subscription jsonb default null)
    RETURNS void AS
$$
BEGIN
    -- if the customer is not null, upsert the data into billing_customers, only upsert fields that are present in the jsonb object
    if customer is not null then
        insert into basejump.billing_customers (id, account_id, email, provider)
        values (customer ->> 'id', service_role_upsert_customer_subscription.account_id, customer ->> 'billing_email',
                (customer ->> 'provider'))
        on conflict (id) do update
            set email = customer ->> 'billing_email';
    end if;

    -- if the subscription is not null, upsert the data into billing_subscriptions, only upsert fields that are present in the jsonb object
    if subscription is not null then
        insert into basejump.billing_subscriptions (id, account_id, billing_customer_id, status, metadata, price_id,
                                                    quantity, cancel_at_period_end, created, current_period_start,
                                                    current_period_end, ended_at, cancel_at, canceled_at, trial_start,
                                                    trial_end, plan_name, provider)
        values (subscription ->> 'id', service_role_upsert_customer_subscription.account_id,
                subscription ->> 'billing_customer_id', (subscription ->> 'status')::basejump.subscription_status,
                subscription -> 'metadata',
                subscription ->> 'price_id', (subscription ->> 'quantity')::int,
                (subscription ->> 'cancel_at_period_end')::boolean,
                (subscription ->> 'created')::timestamptz, (subscription ->> 'current_period_start')::timestamptz,
                (subscription ->> 'current_period_end')::timestamptz, (subscription ->> 'ended_at')::timestamptz,
                (subscription ->> 'cancel_at')::timestamptz,
                (subscription ->> 'canceled_at')::timestamptz, (subscription ->> 'trial_start')::timestamptz,
                (subscription ->> 'trial_end')::timestamptz,
                subscription ->> 'plan_name', (subscription ->> 'provider'))
        on conflict (id) do update
            set billing_customer_id  = subscription ->> 'billing_customer_id',
                status               = (subscription ->> 'status')::basejump.subscription_status,
                metadata             = subscription -> 'metadata',
                price_id             = subscription ->> 'price_id',
                quantity             = (subscription ->> 'quantity')::int,
                cancel_at_period_end = (subscription ->> 'cancel_at_period_end')::boolean,
                current_period_start = (subscription ->> 'current_period_start')::timestamptz,
                current_period_end   = (subscription ->> 'current_period_end')::timestamptz,
                ended_at             = (subscription ->> 'ended_at')::timestamptz,
                cancel_at            = (subscription ->> 'cancel_at')::timestamptz,
                canceled_at          = (subscription ->> 'canceled_at')::timestamptz,
                trial_start          = (subscription ->> 'trial_start')::timestamptz,
                trial_end            = (subscription ->> 'trial_end')::timestamptz,
                plan_name            = subscription ->> 'plan_name';
    end if;
end;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION public.service_role_upsert_customer_subscription(uuid, jsonb, jsonb) TO service_role;