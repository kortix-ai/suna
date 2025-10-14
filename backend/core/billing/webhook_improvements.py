from typing import Dict, Optional
from decimal import Decimal
from datetime import datetime, timezone
from core.utils.logger import logger

async def process_credit_addition_with_idempotency(
    credit_manager,
    account_id: str,
    amount: Decimal,
    is_expiring: bool,
    description: str,
    stripe_event_id: str,
    expires_at: Optional[datetime] = None,
    type: Optional[str] = None
) -> Dict:
    return await credit_manager.add_credits(
        account_id=account_id,
        amount=amount,
        is_expiring=is_expiring,
        description=description,
        expires_at=expires_at,
        type=type,
        stripe_event_id=stripe_event_id
    )

async def process_renewal_with_idempotency(
    credit_manager,
    account_id: str,
    new_credits: Decimal,
    description: str,
    stripe_event_id: str
) -> Dict:
    return await credit_manager.reset_expiring_credits(
        account_id=account_id,
        new_credits=new_credits,
        description=description,
        stripe_event_id=stripe_event_id
    )

def get_stripe_event_id(event) -> Optional[str]:
    if hasattr(event, 'id'):
        return event.id
    elif isinstance(event, dict) and 'id' in event:
        return event['id']
    return None

def should_process_webhook(event_type: str) -> bool:
    processed_events = {
        'checkout.session.completed',
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'invoice.payment_succeeded',
        'invoice_payment.paid',
        'invoice.payment_failed',
        'customer.subscription.trial_will_end'
    }
    return event_type in processed_events
