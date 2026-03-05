from typing import Dict, Optional, List
from decimal import Decimal
from core.services.convex_client import get_convex_client
from core.utils.logger import logger
from core.billing.shared.config import CREDITS_PER_DOLLAR
from .config import MAX_EARNABLE_CREDITS_FROM_REFERRAL
from core.notifications.notification_service import NotificationService
from core.utils.config import config


REFERRAL_MIGRATION_PENDING_MESSAGE = (
    "Referral features are temporarily unavailable while Convex migration is in progress."
)


class ReferralMigrationPendingError(RuntimeError):
    """Raised when referral functionality is not yet implemented for Convex."""


class ReferralService:
    def __init__(self):
        self.notification_service = NotificationService()

    async def _get_client(self):
        # TODO: Convex migration - ReferralService needs Convex client for referral operations
        # The Convex client currently does not support referral RPC calls
        return get_convex_client()
    
    async def expire_and_regenerate_code(self, user_id: str) -> Dict:
        # TODO: Convex migration - need to implement expire_referral_code RPC equivalent
        # The Convex client currently does not support referral RPC calls
        logger.warning(f"expire_and_regenerate_code not yet migrated to Convex for user {user_id}")
        raise ReferralMigrationPendingError(REFERRAL_MIGRATION_PENDING_MESSAGE)

    async def get_or_create_referral_code(self, user_id: str) -> str:
        # TODO: Convex migration - need to implement get_or_create_referral_code RPC equivalent
        # The Convex client currently does not support referral RPC calls
        logger.warning(f"get_or_create_referral_code not yet migrated to Convex for user {user_id}")
        raise ReferralMigrationPendingError(REFERRAL_MIGRATION_PENDING_MESSAGE)

    async def validate_referral_code(self, code: str) -> Optional[str]:
        # TODO: Convex migration - need to implement validate_referral_code RPC equivalent
        # The Convex client currently does not support referral RPC calls
        logger.warning(f"validate_referral_code not yet migrated to Convex for code {code}")
        raise ReferralMigrationPendingError(REFERRAL_MIGRATION_PENDING_MESSAGE)

    async def check_total_earned_credits(self, user_id: str) -> Decimal:
        # TODO: Convex migration - need to implement referral_stats table query
        # The Convex client currently does not support referral stats queries
        logger.warning(f"check_total_earned_credits not yet migrated to Convex for user {user_id}")
        return Decimal('0')
    
    async def process_referral(
        self,
        referrer_id: str,
        referred_account_id: str,
        referral_code: str,
        credits_amount: Optional[Decimal] = None
    ) -> Dict:
        # TODO: Convex migration - need to implement process_referral RPC equivalent
        # The Convex client currently does not support referral RPC calls
        logger.warning(f"process_referral not yet migrated to Convex for referrer {referrer_id}")
        return {
            'success': False,
            'message': 'Referral processing not yet available (Convex migration pending)',
            'credits_awarded': 0
        }

    async def get_referral_stats(self, user_id: str) -> Dict:
        # TODO: Convex migration - need to implement get_referral_stats RPC equivalent
        # The Convex client currently does not support referral RPC calls
        logger.warning(f"get_referral_stats not yet migrated to Convex for user {user_id}")
        return {
            'referral_code': '',
            'total_referrals': 0,
            'successful_referrals': 0,
            'total_credits_earned': 0,
            'last_referral_at': None,
            'remaining_earnable_credits': float(MAX_EARNABLE_CREDITS_FROM_REFERRAL * CREDITS_PER_DOLLAR),
            'max_earnable_credits': float(MAX_EARNABLE_CREDITS_FROM_REFERRAL * CREDITS_PER_DOLLAR),
            'has_reached_limit': False
        }

    async def get_user_referrals(
        self,
        user_id: str,
        limit: int = 50,
        offset: int = 0
    ) -> List[Dict]:
        # TODO: Convex migration - need to implement get_user_referrals RPC equivalent
        # The Convex client currently does not support referral RPC calls
        logger.warning(f"get_user_referrals not yet migrated to Convex for user {user_id}")
        return []

    async def send_referral_email(self, user_id: str, email: str) -> Dict:
        try:
            referral_code = await self.get_or_create_referral_code(user_id)
            
            frontend_url = config.FRONTEND_URL
            referral_url = f"{frontend_url}/auth?ref={referral_code}"

            result = await self.notification_service.send_referral_code_notification(
                recipient_email=email,
                referral_url=referral_url,
                inviter_id=user_id
            )
            
            if result.get('success'):
                logger.info(
                    "Referral email sent successfully",
                    user_id=user_id,
                    recipient_email=email,
                    referral_code=referral_code
                )
                return {
                    'success': True,
                    'message': 'Referral email sent successfully'
                }
            else:
                logger.error(
                    "Failed to send referral email",
                    user_id=user_id,
                    recipient_email=email,
                    error=result.get('error')
                )
                return {
                    'success': False,
                    'message': result.get('error', 'Failed to send email')
                }
        except Exception as e:
            logger.error(f"Error sending referral email: {e}", user_id=user_id, recipient_email=email)
            return {
                'success': False,
                'message': str(e)
            }
    
    async def send_referral_emails(self, user_id: str, emails: List[str]) -> Dict:
        try:
            referral_code = await self.get_or_create_referral_code(user_id)
            
            frontend_url = config.FRONTEND_URL
            referral_url = f"{frontend_url}/auth?ref={referral_code}"

            results = []
            success_count = 0
            
            for email in emails:
                email_clean = email.strip().lower()
                
                result = await self.notification_service.send_referral_code_notification(
                    recipient_email=email_clean,
                    referral_url=referral_url,
                    inviter_id=user_id
                )
                
                email_result = {
                    'email': email_clean,
                    'success': result.get('success', False),
                    'message': result.get('error') if not result.get('success') else 'Email sent successfully'
                }
                
                results.append(email_result)
                
                if result.get('success'):
                    success_count += 1
                    logger.info(
                        "Referral email sent successfully",
                        user_id=user_id,
                        recipient_email=email_clean,
                        referral_code=referral_code
                    )
                else:
                    logger.error(
                        "Failed to send referral email",
                        user_id=user_id,
                        recipient_email=email_clean,
                        error=result.get('error')
                    )
            
            total_count = len(emails)
            
            return {
                'success': success_count > 0,
                'message': f'Successfully sent {success_count} out of {total_count} emails',
                'results': results,
                'success_count': success_count,
                'total_count': total_count
            }
            
        except Exception as e:
            logger.error(f"Error sending referral emails: {e}", user_id=user_id)
            return {
                'success': False,
                'message': str(e),
                'results': []
            }
