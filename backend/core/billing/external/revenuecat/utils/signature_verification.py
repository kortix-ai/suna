import hmac
import hashlib
from core.utils.logger import logger
from core.utils.config import config


class SignatureVerifier:
    def __init__(self):
        self.webhook_secret = getattr(config, 'REVENUECAT_WEBHOOK_SECRET', None)
    
    def verify_signature(self, request_body: bytes, signature: str) -> bool:
        if not self.webhook_secret:
            logger.warning("[REVENUECAT] No webhook secret configured, skipping verification")
            return True
        
        expected_signature = hmac.new(
            self.webhook_secret.encode('utf-8'),
            request_body,
            hashlib.sha256
        ).hexdigest()
        
        return hmac.compare_digest(signature, expected_signature)

