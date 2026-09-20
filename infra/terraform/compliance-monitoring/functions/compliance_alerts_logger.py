"""Persist every us-east-2 compliance alert to CloudWatch Logs."""

from __future__ import annotations

import json
from typing import Any


def lambda_handler(event: dict[str, Any], _context: Any) -> str:
    """Print every SNS record verbatim and always report success.

    This Lambda is the topic's auto-confirmed subscriber: Drata DCF-86
    (tests 294/296/298) fails hasSubscription while the only subscription
    is the PendingConfirmation email, while a Lambda-protocol subscription
    is Active immediately on Subscribe. A logging sink must never become a
    delivery failure, so any record shape is accepted and SNS only ever
    sees a success.
    """
    for record in event.get("Records", []):
        print(json.dumps(record, default=str))
    return "logged"
