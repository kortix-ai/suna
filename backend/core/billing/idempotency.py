import hashlib
from datetime import datetime, timezone
from typing import Optional


def generate_idempotency_key(
    operation: str,
    account_id: str,
    *args,
    time_bucket_hours: int = 1,
    **kwargs
) -> str:
    timestamp_bucket = int(datetime.now(timezone.utc).timestamp() // (time_bucket_hours * 3600))
    sorted_kwargs = sorted(kwargs.items())
    
    components = [
        operation,
        account_id,
        *[str(arg) for arg in args],
        *[f"{k}={v}" for k, v in sorted_kwargs],
        str(timestamp_bucket)
    ]
    
    idempotency_base = "_".join(components)
    
    return hashlib.sha256(idempotency_base.encode()).hexdigest()[:40]


def generate_checkout_idempotency_key(
    account_id: str,
    price_id: str,
    commitment_type: Optional[str] = None
) -> str:
    return generate_idempotency_key(
        'checkout',
        account_id,
        price_id,
        commitment_type=commitment_type or 'none'
    )


def generate_trial_idempotency_key(account_id: str, trial_days: int) -> str:
    return generate_idempotency_key(
        'trial_checkout',
        account_id,
        trial_days
    )


def generate_credit_purchase_idempotency_key(
    account_id: str,
    amount: float
) -> str:
    return generate_idempotency_key(
        'credit_purchase',
        account_id,
        amount
    )


def generate_subscription_modify_idempotency_key(
    subscription_id: str,
    new_price_id: str
) -> str:
    return generate_idempotency_key(
        'modify_subscription',
        subscription_id,
        new_price_id
    )


def generate_subscription_cancel_idempotency_key(
    subscription_id: str,
    cancel_type: str = 'at_period_end'
) -> str:
    return generate_idempotency_key(
        'cancel_subscription',
        subscription_id,
        cancel_type
    )


def generate_refund_idempotency_key(
    payment_intent_id: str,
    amount: Optional[float] = None
) -> str:
    return generate_idempotency_key(
        'refund',
        payment_intent_id,
        amount or 'full'
    )

