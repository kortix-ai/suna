from fastapi import HTTPException
from typing import Dict
from decimal import Decimal
from datetime import datetime, timezone
import stripe
from core.services.supabase import DBConnection
from core.utils.logger import logger
from .idempotency import generate_credit_purchase_idempotency_key
from .stripe_circuit_breaker import StripeAPIWrapper


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
        
        purchase_id = None
        try:
            purchase_record = await client.table('credit_purchases').insert({
                'account_id': account_id,
                'amount_dollars': float(amount),
                'stripe_payment_intent_id': None,
                'status': 'pending',
                'created_at': datetime.now(timezone.utc).isoformat(),
                'metadata': {'amount': float(amount)}
            }).execute()
            
            if purchase_record.data:
                purchase_id = purchase_record.data[0]['id']
                logger.info(f"[PAYMENT] Created purchase record {purchase_id} for account {account_id}")
        except Exception as e:
            logger.error(f"[PAYMENT FAILURE] Failed to create purchase record: {e}")
            raise HTTPException(status_code=500, detail="Failed to initialize payment")
        
        import hashlib
        idempotency_key = hashlib.sha256(f"{account_id}_{purchase_id}_{amount}".encode()).hexdigest()[:40]
        
        try:
            session = await StripeAPIWrapper.create_checkout_session(
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
                    'credit_amount': str(amount),
                    'purchase_id': str(purchase_id)
                },
                idempotency_key=idempotency_key
            )
            
            payment_intent_id = session.payment_intent if session.payment_intent else None
            
            if not payment_intent_id:
                logger.warning(f"[PAYMENT] No payment_intent in session {session.id} for account {account_id} - will track by session_id")
            
            await client.table('credit_purchases').update({
                'stripe_payment_intent_id': payment_intent_id,
                'status': 'pending',
                'metadata': {'session_id': session.id, 'amount': float(amount), 'purchase_id': str(purchase_id)}
            }).eq('id', purchase_id).execute()
            
            logger.info(f"[PAYMENT SUCCESS] Created checkout session {session.id} for purchase {purchase_id}")
            return {'checkout_url': session.url}
            
        except Exception as e:
            logger.critical(
                f"[PAYMENT FAILURE - ORPHAN RISK] Stripe checkout failed! "
                f"account_id={account_id}, purchase_id={purchase_id}, amount=${amount}, error={e}"
            )
            
            try:
                await client.table('credit_purchases').update({
                    'status': 'failed',
                    'metadata': {'error': str(e), 'failed_at': datetime.now(timezone.utc).isoformat()}
                }).eq('id', purchase_id).execute()
            except Exception as log_error:
                logger.error(f"[PAYMENT FAILURE] Failed to update purchase record: {log_error}")
            
            raise HTTPException(status_code=500, detail="Failed to create payment session")


payment_service = PaymentService() 