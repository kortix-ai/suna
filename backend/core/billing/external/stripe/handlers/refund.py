from decimal import Decimal
from datetime import datetime, timezone
from core.utils.logger import logger
from core.billing.credits.manager import credit_manager
from core.billing import repo as billing_repo


class RefundHandler:
    @staticmethod
    async def handle_refund(event, client=None):
        refund_obj = event.data.object
        
        if event.type == 'charge.refunded':
            charge = refund_obj
            refund_id = charge.get('refunds', {}).get('data', [{}])[0].get('id') if charge.get('refunds') else None
            charge_id = charge.get('id')
            payment_intent_id = charge.get('payment_intent')
            amount_refunded = Decimal(str(charge.get('amount_refunded', 0))) / Decimal('100')
        else:
            payment_intent = refund_obj
            refund_id = payment_intent.get('charges', {}).get('data', [{}])[0].get('refunds', {}).get('data', [{}])[0].get('id')
            charge_id = payment_intent.get('charges', {}).get('data', [{}])[0].get('id')
            payment_intent_id = payment_intent.get('id')
            amount_refunded = Decimal(str(payment_intent.get('amount', 0))) / Decimal('100')
        
        if not refund_id or not charge_id:
            logger.error(f"[REFUND] Missing refund_id or charge_id in event {event.id}")
            return
        
        existing_refund = await billing_repo.get_refund_by_stripe_id(refund_id)
        
        if existing_refund:
            if existing_refund['status'] == 'processed':
                logger.info(f"[REFUND] Refund {refund_id} already processed")
                return
        
        purchase = await billing_repo.get_purchase_by_payment_intent(payment_intent_id)
        
        if not purchase:
            logger.warning(f"[REFUND] No purchase found for payment_intent {payment_intent_id}")
            
            if not existing_refund:
                await billing_repo.create_refund_history(
                    account_id='00000000-0000-0000-0000-000000000000',
                    stripe_refund_id=refund_id,
                    stripe_charge_id=charge_id,
                    stripe_payment_intent_id=payment_intent_id,
                    amount_refunded=float(amount_refunded),
                    credits_deducted=0,
                    refund_reason='No associated purchase found',
                    status='failed',
                    error_message='Purchase record not found',
                    processed_at=datetime.now(timezone.utc).isoformat()
                )
            return
        
        account_id = purchase['account_id']
        credits_to_deduct = Decimal(str(purchase['amount_dollars']))
        
        try:
            if not existing_refund:
                await billing_repo.create_refund_history(
                    account_id=account_id,
                    stripe_refund_id=refund_id,
                    stripe_charge_id=charge_id,
                    stripe_payment_intent_id=payment_intent_id,
                    amount_refunded=float(amount_refunded),
                    credits_deducted=0,
                    status='pending',
                    metadata={'purchase_id': purchase['id']}
                )
            
            balance_info = await credit_manager.get_balance(account_id)
            current_balance = Decimal(str(balance_info['total']))
            
            if current_balance < credits_to_deduct:
                logger.warning(
                    f"[REFUND] Insufficient balance for full refund. "
                    f"Balance: ${current_balance}, Need: ${credits_to_deduct}"
                )
                credits_to_deduct = current_balance
            
            if credits_to_deduct > 0:
                result = await credit_manager.use_credits(
                    account_id=account_id,
                    amount=credits_to_deduct,
                    description=f"Refund deduction: {refund_id}",
                    thread_id=None,
                    message_id=None
                )
                
                if not result.get('success'):
                    logger.error(f"[REFUND] Failed to deduct credits: {result.get('error')}")
                    await billing_repo.update_refund_history(
                        stripe_refund_id=refund_id,
                        status='failed',
                        error_message=result.get('error'),
                        processed_at=datetime.now(timezone.utc).isoformat()
                    )
                    return
            
            await billing_repo.update_purchase_status(
                purchase_id=purchase['id'],
                status='refunded',
                metadata={'refund_id': refund_id, 'refund_processed_at': datetime.now(timezone.utc).isoformat()}
            )
            
            await billing_repo.update_refund_history(
                stripe_refund_id=refund_id,
                status='processed',
                credits_deducted=float(credits_to_deduct),
                processed_at=datetime.now(timezone.utc).isoformat()
            )
            
            logger.info(
                f"[REFUND] Successfully processed refund {refund_id} for account {account_id}. "
                f"Deducted ${credits_to_deduct} credits"
            )
            
        except Exception as e:
            logger.error(f"[REFUND] Error processing refund {refund_id}: {e}")
            await billing_repo.update_refund_history(
                stripe_refund_id=refund_id,
                status='failed',
                error_message=str(e),
                processed_at=datetime.now(timezone.utc).isoformat()
            )

