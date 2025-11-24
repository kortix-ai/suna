from fastapi import HTTPException
from typing import Optional
import stripe

from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.billing.external.stripe import StripeAPIWrapper

class CustomerHandler:
    @staticmethod
    async def get_or_create_stripe_customer(account_id: str) -> str:
        db = DBConnection()
        client = await db.client
        
        customer_result = await client.schema('basejump').from_('billing_customers')\
            .select('id, email')\
            .eq('account_id', account_id)\
            .execute()
        
        if customer_result.data:
            customer_id = customer_result.data[0]['id']
            try:
                await StripeAPIWrapper.safe_stripe_call(
                    stripe.Customer.retrieve_async,
                    customer_id
                )
                logger.info(f"[BILLING] Found existing Stripe customer {customer_id} for account {account_id}")
                return customer_id
            except stripe.error.InvalidRequestError as e:
                if 'No such customer' in str(e):
                    logger.warning(f"[BILLING] Customer {customer_id} not found in Stripe, deleting stale record and creating new customer")
                    await client.schema('basejump').from_('billing_customers')\
                        .delete()\
                        .eq('account_id', account_id)\
                        .execute()
                else:
                    raise
            except Exception as e:
                logger.error(f"[BILLING] Error verifying customer {customer_id}: {e}")
                raise
        
        account_result = await client.schema('basejump').from_('accounts')\
            .select('id, name, personal_account, primary_owner_user_id')\
            .eq('id', account_id)\
            .execute()
        
        if not account_result.data:
            raise HTTPException(status_code=404, detail="Account not found")
        
        account = account_result.data[0]
        user_id = account['primary_owner_user_id']

        email = await CustomerHandler._get_user_email(client, user_id, account_id)
        
        customer = await StripeAPIWrapper.safe_stripe_call(
            stripe.Customer.create_async,
            email=email,
            metadata={'account_id': account_id}
        )
        
        await client.schema('basejump').from_('billing_customers').insert({
            'id': customer.id,
            'account_id': account_id,
            'email': email
        }).execute()
    
        return customer.id

    @staticmethod
    async def _get_user_email(client, user_id: str, account_id: str) -> str:
        email = None
        
        try:
            user_result = await client.auth.admin.get_user_by_id(user_id)
            email = user_result.user.email if user_result and user_result.user else None
        except Exception as e:
            logger.warning(f"Failed to get user via auth.admin API for user {user_id}: {e}")
        
        if not email:
            try:
                user_email_result = await client.rpc('get_user_email', {'user_id': user_id}).execute()
                if user_email_result.data:
                    email = user_email_result.data
            except Exception as e:
                logger.warning(f"Failed to get email via RPC for user {user_id}: {e}")
        
        if not email:
            logger.error(f"Could not find email for user {user_id} / account {account_id}")
            raise HTTPException(
                status_code=400, 
                detail="Unable to retrieve user email. Please ensure your account has a valid email address."
            )
        
        return email
