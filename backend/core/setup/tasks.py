import dramatiq
from core.utils.logger import logger
from core.notifications.notification_service import notification_service
from core.services.email import email_service
from core.services.dramatiq_broker import ensure_broker

ensure_broker()


@dramatiq.actor(queue_name="default", max_retries=3, min_backoff=1000, max_backoff=60000)
async def send_welcome_notification_task(account_id: str, user_name: str, email: str):
    try:
        logger.info(f"[WELCOME_TASK] Processing welcome notification for {email}")
        result = await notification_service.send_welcome_email(
            account_id=account_id,
            account_name=user_name,
            account_email=email
        )
        
        if result.get('success'):
            logger.info(f"✅ [WELCOME_TASK] Novu welcome email sent to {email}")
        else:
            logger.warning(f"⚠️ [WELCOME_TASK] Novu failed for {email}, using fallback")
            _send_fallback_email(email, user_name)
            
    except Exception as e:
        logger.error(f"❌ [WELCOME_TASK] Error sending welcome notification to {email}: {e}")
        _send_fallback_email(email, user_name)
        raise


def _send_fallback_email(email: str, user_name: str):
    try:
        logger.info(f"[WELCOME_TASK] Using fallback email service for {email}")
        email_service.send_welcome_email(
            user_email=email,
            user_name=user_name
        )
        logger.info(f"✅ [WELCOME_TASK] Fallback email sent to {email}")
    except Exception as e:
        logger.error(f"❌ [WELCOME_TASK] Fallback email also failed for {email}: {e}")
