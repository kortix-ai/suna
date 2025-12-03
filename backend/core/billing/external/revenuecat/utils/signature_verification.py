from core.utils.logger import logger
from core.utils.config import config


class SignatureVerifier:
    def __init__(self):
        self.webhook_secret = getattr(config, 'REVENUECAT_WEBHOOK_SECRET', None)
    
    def verify_authorization(self, authorization_header: str) -> bool:
        if not self.webhook_secret:
            logger.error(
                "[REVENUECAT] ❌ No webhook secret configured. "
                "Set REVENUECAT_WEBHOOK_SECRET to enable authorization verification."
            )
            return False
        
        if not authorization_header:
            logger.warning("[REVENUECAT] No Authorization header provided in webhook request")
            return False
        
        # RevenueCat sends Authorization header with the configured value
        # Remove "Bearer " prefix if present
        auth_value = authorization_header.replace('Bearer ', '').strip()
        
        is_valid = auth_value == self.webhook_secret
        
        if not is_valid:
            logger.warning(
                f"[REVENUECAT] ⚠️ Authorization verification failed. "
                f"Received: {auth_value[:16]}..., Expected: {self.webhook_secret[:16]}..."
            )
        
        return is_valid

