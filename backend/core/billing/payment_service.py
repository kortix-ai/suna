from fastapi import HTTPException
from typing import Dict
from decimal import Decimal
import stripe
from core.services.supabase import DBConnection
from core.utils.logger import logger
from .idempotency import generate_credit_purchase_idempotency_key


class PaymentService:
    def __init__(self):
        self.stripe = stripe

    async def create_credit_purchase_checkout(
        self, 
        account_id: str, 
        amount: Decimal, 
        success_url: str, 
        cancel_url: str,
        get_user_subscription_tier_func
    ) -> Dict:
        tier = await get_user_subscription_tier_func(account_id)
        if not tier.get('can_purchase_credits', False):
            raise HTTPException(status_code=403, detail="Credit purchases not available for your tier")
        
        db = DBConnection()
        client = await db.client
        
        customer_result = await client.schema('basejump').from_('billing_customers').select('id, email').eq('account_id', account_id).execute()
        
        if not customer_result.data or len(customer_result.data) == 0:
            raise HTTPException(status_code=400, detail="No billing customer found")
        
        idempotency_key = generate_credit_purchase_idempotency_key(account_id, float(amount))
        
        session = await stripe.checkout.Session.create_async(
            customer=customer_result.data[0]['id'],
            payment_method_types=['card'],
            line_items=[{
                'price_data': {
                    'currency': 'usd',
                    'product_data': {'name': f'${amount} Credits'},
                    'unit_amount': int(amount * 100)
                },
                'quantity': 1
            }],
            mode='payment',
            success_url=success_url,
            cancel_url=cancel_url,
            metadata={
                'type': 'credit_purchase',
                'account_id': account_id,
                'credit_amount': str(amount)
            },
            idempotency_key=idempotency_key
        )
        
        payment_intent_id = session.payment_intent if session.payment_intent else None
        
        if not payment_intent_id:
            logger.warning(f"[PAYMENT] No payment_intent in session {session.id} for account {account_id} - will track by session_id")
        
        await client.table('credit_purchases').insert({
            'account_id': account_id,
            'amount_dollars': float(amount),
            'stripe_payment_intent_id': payment_intent_id,
            'stripe_checkout_session_id': session.id,
            'status': 'pending',
            'metadata': {'session_id': session.id, 'amount': float(amount)}
        }).execute()
        
        return {'checkout_url': session.url}


payment_service = PaymentService() 