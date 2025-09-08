from fastapi import HTTPException
from typing import Dict
from decimal import Decimal
import stripe
from core.services.supabase import DBConnection
from core.utils.logger import logger


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
            }
        )
        
        await client.table('credit_purchases').insert({
            'account_id': account_id,
            'amount_dollars': float(amount),
            'stripe_payment_intent_id': session.payment_intent,
            'status': 'pending',
            'metadata': {'session_id': session.id}
        }).execute()
        
        return {'checkout_url': session.url}


payment_service = PaymentService() 