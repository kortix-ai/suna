from typing import Dict, Optional, List
from decimal import Decimal
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.billing.shared.config import CREDITS_PER_DOLLAR
from .config import REFERRAL_CREDITS, MAX_EARNABLE_CREDITS_FROM_REFERRAL
import json
import re
from core.notifications.notification_service import NotificationService
from core.utils.config import config

class ReferralService:
    def __init__(self, db: DBConnection):
        self.db = db
        self.notification_service = NotificationService()
    
    async def _get_client(self):
        return await self.db.client
    
    async def expire_and_regenerate_code(self, user_id: str) -> Dict:
        import json
        import re
        
        try:
            client = await self._get_client()
            response = await client.rpc('expire_referral_code', {
                'p_account_id': user_id
            }).execute()
            
            if response.data:
                if isinstance(response.data, str):
                    return json.loads(response.data)
                return response.data
            else:
                raise Exception("Failed to expire and regenerate referral code")
        except Exception as e:
            error_msg = str(e)
            if 'Referral code refreshed successfully' in error_msg or 'new_code' in error_msg:
                match = re.search(r'\{[^{}]*"success"[^{}]*\}', error_msg)
                if match:
                    try:
                        result = json.loads(match.group(0))
                        logger.info(
                            "Referral code refreshed successfully",
                            user_id=user_id,
                            old_code=result.get('old_code'),
                            new_code=result.get('new_code')
                        )
                        return result
                    except json.JSONDecodeError:
                        pass
            
            logger.error(f"Error expiring referral code: {e}", user_id=user_id)
            raise
    
    async def get_or_create_referral_code(self, user_id: str) -> str:
        try:
            client = await self._get_client()
            result = await client.rpc('get_or_create_referral_code', {
                'p_account_id': user_id
            }).execute()
            
            if result.data:
                return result.data
            else:
                raise Exception("Failed to get or create referral code")
        except Exception as e:
            logger.error(f"Error getting/creating referral code: {e}", user_id=user_id)
            raise
    
    async def validate_referral_code(self, code: str) -> Optional[str]:
        try:
            client = await self._get_client()
            
            result = await client.rpc('validate_referral_code', {
                'p_code': code.upper()
            }).execute()
            
            return result.data if result.data else None
        except Exception as e:
            logger.error(f"Error validating referral code: {e}", code=code)
            raise
    
    async def check_total_earned_credits(self, user_id: str) -> Decimal:
        try:
            client = await self._get_client()
            
            result = await client.from_('referral_stats').select('total_credits_earned').eq('account_id', user_id).single().execute()
            
            if result.data:
                return Decimal(str(result.data.get('total_credits_earned', 0)))
            return Decimal('0')
        except Exception as e:
            logger.warning(f"Could not fetch total earned credits, defaulting to 0: {e}", user_id=user_id)
            return Decimal('0')
    
    async def process_referral(
        self,
        referrer_id: str,
        referred_account_id: str,
        referral_code: str,
        credits_amount: Optional[Decimal] = None
    ) -> Dict:
        if credits_amount is None:
            credits_amount = REFERRAL_CREDITS
        
        total_earned = await self.check_total_earned_credits(referrer_id)
        
        if total_earned >= MAX_EARNABLE_CREDITS_FROM_REFERRAL:
            logger.warning(
                f"Referrer has reached max earnable credits limit",
                referrer_id=referrer_id,
                total_earned=total_earned,
                max_limit=MAX_EARNABLE_CREDITS_FROM_REFERRAL
            )
            return {
                'success': False,
                'message': f'Referrer has reached maximum earnable credits limit of {MAX_EARNABLE_CREDITS_FROM_REFERRAL}',
                'credits_awarded': 0
            }
        
        remaining_credits = MAX_EARNABLE_CREDITS_FROM_REFERRAL - total_earned
        actual_credits_to_award = min(credits_amount, remaining_credits)
        
        if actual_credits_to_award <= 0:
            return {
                'success': False,
                'message': 'No credits to award',
                'credits_awarded': 0
            }
        
        try:
            client = await self._get_client()
            
            response = await client.rpc('process_referral', {
                'p_referrer_id': referrer_id,
                'p_referred_account_id': referred_account_id,
                'p_referral_code': referral_code,
                'p_credits_amount': str(actual_credits_to_award)
            }).execute()
            
            if response.data:
                if isinstance(response.data, str):
                    return json.loads(response.data)
                return response.data
            else:
                raise Exception("Failed to process referral")
        except Exception as e:
            error_msg = str(e)
            if 'Referral processed successfully' in error_msg or 'credits_awarded' in error_msg:
                match = re.search(r'\{[^{}]*"success"[^{}]*\}', error_msg)
                if match:
                    try:
                        result = json.loads(match.group(0))
                        logger.info(
                            "Referral processed successfully",
                            referrer_id=referrer_id,
                            referred_account_id=referred_account_id,
                            credits_awarded=result.get('credits_awarded'),
                            total_earned_after=total_earned + actual_credits_to_award,
                            remaining_limit=MAX_EARNABLE_CREDITS_FROM_REFERRAL - total_earned - actual_credits_to_award
                        )
                        return result
                    except json.JSONDecodeError:
                        pass
            
            logger.error(
                f"Error processing referral: {e}",
                referrer_id=referrer_id,
                referred_account_id=referred_account_id
            )
            raise
    
    async def get_referral_stats(self, user_id: str) -> Dict:
        try:
            client = await self._get_client()
            
            result = await client.rpc('get_referral_stats', {
                'p_account_id': user_id
            }).execute()
            
            if result.data:
                stats = result.data
                total_earned = Decimal(str(stats.get('total_credits_earned', 0)))
                
                stats['total_credits_earned'] = float(total_earned * CREDITS_PER_DOLLAR)
                stats['remaining_earnable_credits'] = float((MAX_EARNABLE_CREDITS_FROM_REFERRAL - total_earned) * CREDITS_PER_DOLLAR)
                stats['max_earnable_credits'] = float(MAX_EARNABLE_CREDITS_FROM_REFERRAL * CREDITS_PER_DOLLAR)
                stats['has_reached_limit'] = total_earned >= MAX_EARNABLE_CREDITS_FROM_REFERRAL
                
                return stats
            else:
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
        except Exception as e:
            logger.error(f"Error getting referral stats: {e}", user_id=user_id)
            raise
    
    async def get_user_referrals(
        self,
        user_id: str,
        limit: int = 50,
        offset: int = 0
    ) -> List[Dict]:
        try:
            client = await self._get_client()
            
            result = await client.rpc('get_user_referrals', {
                'p_account_id': user_id,
                'p_limit': limit,
                'p_offset': offset
            }).execute()
            
            if result.data:
                return result.data if isinstance(result.data, list) else []
            else:
                return []
        except Exception as e:
            logger.error(f"Error getting user referrals: {e}", user_id=user_id)
            raise

    async def send_referral_email(self, user_id: str, email: str) -> Dict:
        try:
            referral_code = await self.get_or_create_referral_code(user_id)
            
            from core.utils.config import config
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
            
            from core.utils.config import config
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