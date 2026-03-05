from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timedelta, timezone
from core.services.convex_client import get_convex_client, ConvexError, NotFoundError
from core.utils.auth_utils import verify_and_get_user_id_from_jwt, verify_admin_api_key
from core.utils.logger import logger
from core.sandbox.sandbox import delete_sandbox
from core.billing.external.stripe import StripeAPIWrapper

router = APIRouter(tags=["account-deletion"])

class AccountDeletionRequest(BaseModel):
    reason: Optional[str] = None

class AccountDeletionResponse(BaseModel):
    success: bool
    message: str
    deletion_scheduled_for: Optional[datetime] = None
    can_cancel: bool = True

class AccountDeletionStatusResponse(BaseModel):
    has_pending_deletion: bool
    deletion_scheduled_for: Optional[datetime] = None
    requested_at: Optional[datetime] = None
    can_cancel: bool = True

@router.post("/account/request-deletion", response_model=AccountDeletionResponse)
async def request_account_deletion(
    body: AccountDeletionRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        convex = get_convex_client()

        # TODO: Migrate to Convex - need basejump accounts table equivalent
        # personal_account_response = await client.schema('basejump').table('accounts').select('id').eq('primary_owner_user_id', user_id).eq('personal_account', True).execute()
        raise HTTPException(status_code=501, detail="Account deletion not yet migrated to Convex - basejump accounts table needed")

        # The following code is kept for reference but won't execute
        account_id = None  # Would come from above query

        # TODO: Migrate to Convex - need account_deletion_requests table operations
        # existing_request = await client.table('account_deletion_requests').select('*').eq('account_id', account_id).eq('is_cancelled', False).eq('is_deleted', False).execute()

        deletion_date = datetime.now(timezone.utc) + timedelta(days=30)

        # TODO: Migrate to Convex - need account_deletion_requests insert
        # deletion_request = await client.table('account_deletion_requests').insert({...}).execute()

        await check_and_schedule_subscriptions(account_id, deletion_date, convex)

        logger.info(f"Account deletion requested for user {user_id}, scheduled for {deletion_date} (will be processed by daily check)")

        return AccountDeletionResponse(
            success=True,
            message="Account deletion has been scheduled. Your data will be permanently deleted in 30 days. You can cancel this request anytime within this period.",
            deletion_scheduled_for=deletion_date,
            can_cancel=True
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error requesting account deletion: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to request account deletion")

@router.post("/account/cancel-deletion")
async def cancel_account_deletion(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        convex = get_convex_client()

        # TODO: Migrate to Convex - need basejump accounts table equivalent
        # personal_account_response = await client.schema('basejump').table('accounts').select('id').eq('primary_owner_user_id', user_id).eq('personal_account', True).execute()
        raise HTTPException(status_code=501, detail="Account deletion cancellation not yet migrated to Convex - basejump accounts table needed")

        account_id = None  # Would come from above query

        # TODO: Migrate to Convex - need account_deletion_requests table operations
        # existing_request = await client.table('account_deletion_requests').select('*').eq('account_id', account_id).eq('is_cancelled', False).eq('is_deleted', False).execute()

        request_id = None  # Would come from above query

        # TODO: Migrate to Convex - need account_deletion_requests update
        # await client.table('account_deletion_requests').update({...}).eq('id', request_id).execute()

        await unschedule_subscription_cancellation(account_id, convex)

        logger.info(f"Account deletion cancelled for user {user_id}")

        return {
            "success": True,
            "message": "Account deletion has been cancelled. Your account and data are safe."
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error cancelling account deletion: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to cancel account deletion")

@router.get("/account/deletion-status", response_model=AccountDeletionStatusResponse)
async def get_account_deletion_status(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        convex = get_convex_client()

        # TODO: Migrate to Convex - need basejump accounts table equivalent
        # personal_account_response = await client.schema('basejump').table('accounts').select('id').eq('primary_owner_user_id', user_id).eq('personal_account', True).execute()
        raise HTTPException(status_code=501, detail="Account deletion status not yet migrated to Convex - basejump accounts table needed")

        return AccountDeletionStatusResponse(
            has_pending_deletion=False,
            deletion_scheduled_for=None,
            requested_at=None,
            can_cancel=False
        )

    except Exception as e:
        logger.error(f"Error getting account deletion status: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to get account deletion status")

class DeleteSandboxesRequest(BaseModel):
    account_id: str

@router.post("/internal/delete-account-sandboxes")
async def delete_account_sandboxes_endpoint(
    request: DeleteSandboxesRequest,
    _: bool = Depends(verify_admin_api_key)
):
    """Internal endpoint to delete all sandboxes for an account. Called by cron jobs. Protected by admin API key."""
    try:
        convex = get_convex_client()

        deleted_count = await delete_account_sandboxes(request.account_id, convex)

        return {
            "success": True,
            "deleted_count": deleted_count,
            "account_id": request.account_id
        }
    except Exception as e:
        logger.error(f"Error in delete_account_sandboxes_endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to delete sandboxes: {str(e)}")

async def check_and_schedule_subscriptions(account_id: str, cancel_at: datetime, convex) -> None:
    try:
        # TODO: Migrate to Convex - need credit_accounts table operations
        # credit_account = await client.from_('credit_accounts').select(
        #     'stripe_subscription_id, revenuecat_subscription_id, tier, provider'
        # ).eq('account_id', account_id).execute()
        logger.info(f"[ACCOUNT_DELETION] check_and_schedule_subscriptions needs credit_accounts table migration for {account_id}")
        return

        account_data = {}  # Would come from above query
        stripe_sub_id = account_data.get('stripe_subscription_id')
        revenuecat_sub_id = account_data.get('revenuecat_subscription_id')
        tier = account_data.get('tier')
        provider = account_data.get('provider', 'stripe')

        if revenuecat_sub_id and tier not in ['none', 'free']:
            logger.warning(f"[ACCOUNT_DELETION] User {account_id} has active RevenueCat subscription - must cancel through app store first")
            raise HTTPException(
                status_code=400,
                detail="You have an active subscription through the App Store or Google Play. Please cancel your subscription through your device's subscription settings before deleting your account. Once cancelled, wait for your subscription to expire, then you can delete your account."
            )

        if stripe_sub_id:
            await schedule_stripe_subscription_cancellation(account_id, stripe_sub_id, cancel_at, tier)
        else:
            logger.info(f"[ACCOUNT_DELETION] No Stripe subscription to schedule for account {account_id}")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[ACCOUNT_DELETION] Error checking subscriptions for account {account_id}: {str(e)}")
        raise

async def schedule_stripe_subscription_cancellation(account_id: str, stripe_sub_id: str, cancel_at: datetime, tier: str) -> None:
    try:
        cancel_at_timestamp = int(cancel_at.timestamp())

        logger.info(f"[ACCOUNT_DELETION] Scheduling Stripe subscription {stripe_sub_id} to cancel at {cancel_at.date()} for account {account_id} (tier: {tier})")

        await StripeAPIWrapper.modify_subscription(
            stripe_sub_id,
            cancel_at=cancel_at_timestamp
        )

        logger.info(f"[ACCOUNT_DELETION] ✅ Successfully scheduled subscription {stripe_sub_id} to cancel in 30 days")

    except Exception as e:
        logger.error(f"[ACCOUNT_DELETION] Error scheduling Stripe subscription cancellation for account {account_id}: {str(e)}")
        raise

async def unschedule_subscription_cancellation(account_id: str, convex) -> None:
    try:
        # TODO: Migrate to Convex - need credit_accounts table operations
        # credit_account = await client.from_('credit_accounts').select(
        #     'stripe_subscription_id'
        # ).eq('account_id', account_id).execute()
        logger.info(f"[ACCOUNT_DELETION] unschedule_subscription_cancellation needs credit_accounts table migration for {account_id}")
        return

        stripe_sub_id = None  # Would come from above query

        if not stripe_sub_id:
            logger.info(f"[ACCOUNT_DELETION] No Stripe subscription for account {account_id}")
            return

        logger.info(f"[ACCOUNT_DELETION] Removing scheduled cancellation for Stripe subscription {stripe_sub_id}")

        await StripeAPIWrapper.modify_subscription(
            stripe_sub_id,
            cancel_at=None,
            cancel_at_period_end=False
        )

        logger.info(f"[ACCOUNT_DELETION] ✅ Successfully removed scheduled cancellation for {stripe_sub_id}")

    except Exception as e:
        logger.error(f"[ACCOUNT_DELETION] Error removing scheduled subscription cancellation for account {account_id}: {str(e)}")
        raise

async def cancel_account_subscriptions_immediately(account_id: str, convex) -> dict:
    result = {
        "cancelled_stripe": False,
        "cancelled_revenuecat": False,
        "stripe_subscription_id": None,
        "revenuecat_subscription_id": None
    }

    try:
        # TODO: Migrate to Convex - need credit_accounts table operations
        # credit_account = await client.from_('credit_accounts').select(
        #     'stripe_subscription_id, revenuecat_subscription_id, tier, provider'
        # ).eq('account_id', account_id).execute()
        logger.info(f"[ACCOUNT_DELETION] cancel_account_subscriptions_immediately needs credit_accounts table migration for {account_id}")
        return result

        account_data = {}  # Would come from above query
        stripe_sub_id = account_data.get('stripe_subscription_id')
        revenuecat_sub_id = account_data.get('revenuecat_subscription_id')
        tier = account_data.get('tier')
        provider = account_data.get('provider', 'stripe')

        if revenuecat_sub_id and tier not in ['none', 'free']:
            logger.warning(f"[ACCOUNT_DELETION] User {account_id} has active RevenueCat subscription - cannot delete immediately")
            raise HTTPException(
                status_code=400,
                detail="You have an active subscription through the App Store or Google Play. Please cancel your subscription through your device's subscription settings before deleting your account. Once cancelled, wait for your subscription to expire, then you can delete your account."
            )

        if stripe_sub_id:
            try:
                logger.info(f"[ACCOUNT_DELETION] Cancelling Stripe subscription {stripe_sub_id} for account {account_id} (tier: {tier})")
                await StripeAPIWrapper.cancel_subscription(stripe_sub_id, cancel_immediately=True)
                result["cancelled_stripe"] = True
                result["stripe_subscription_id"] = stripe_sub_id
                logger.info(f"[ACCOUNT_DELETION] ✅ Successfully cancelled Stripe subscription {stripe_sub_id}")
            except Exception as e:
                logger.error(f"[ACCOUNT_DELETION] Failed to cancel Stripe subscription {stripe_sub_id}: {str(e)}")
                raise
        else:
            logger.info(f"[ACCOUNT_DELETION] No Stripe subscription to cancel for account {account_id}")

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[ACCOUNT_DELETION] Error cancelling subscriptions for account {account_id}: {str(e)}")
        raise

async def delete_account_sandboxes(account_id: str, convex) -> int:
    """Delete all Daytona sandboxes associated with an account's resources."""
    from core.resources import ResourceService, ResourceType, ResourceStatus

    deleted_count = 0
    try:
        # TODO: Migrate to Convex - ResourceService needs Convex client integration
        # resource_service = ResourceService(client)
        logger.info(f"[ACCOUNT_DELETION] delete_account_sandboxes needs ResourceService migration for {account_id}")
        return deleted_count

        # The following code is kept for reference
        # resource_service = ResourceService(convex)

        # # Get all sandbox resources for this account
        # resources = await resource_service.get_account_resources(
        #     account_id=account_id,
        #     resource_type=ResourceType.SANDBOX,
        #     status=ResourceStatus.ACTIVE
        # )

        # if not resources:
        #     logger.info(f"No sandbox resources found for account {account_id}")
        #     return 0

        # for resource in resources:
        #     sandbox_id = resource.get('external_id')
        #     resource_id = resource.get('id')

        #     if not sandbox_id:
        #         continue

        #     try:
        #         # Delete the actual Daytona sandbox
        #         await delete_sandbox(sandbox_id)

        #         # Mark resource as deleted
        #         await resource_service.delete_resource(resource_id)

        #         deleted_count += 1
        #         logger.info(f"Deleted sandbox {sandbox_id} (resource {resource_id}) for account {account_id}")
        #     except Exception as e:
        #         # Log but don't fail - sandbox might already be deleted or not exist
        #         logger.warning(f"Failed to delete sandbox {sandbox_id} (resource {resource_id}): {str(e)}")

        logger.info(f"Deleted {deleted_count} sandboxes for account {account_id}")
        return deleted_count
    except Exception as e:
        logger.error(f"Error deleting sandboxes for account {account_id}: {str(e)}")
        # Don't raise - continue with account deletion even if sandbox deletion fails
        return deleted_count

@router.delete("/account/delete-immediately")
async def delete_account_immediately(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        convex = get_convex_client()

        # TODO: Migrate to Convex - need basejump accounts table equivalent
        # personal_account_response = await client.schema('basejump').table('accounts').select('id').eq('primary_owner_user_id', user_id).eq('personal_account', True).execute()
        raise HTTPException(status_code=501, detail="Immediate account deletion not yet migrated to Convex - basejump accounts table needed")

        account_id = None  # Would come from above query

        cancel_result = await cancel_account_subscriptions_immediately(account_id, convex)
        logger.info(f"Cancelled subscriptions before account deletion: {cancel_result}")

        sandbox_count = await delete_account_sandboxes(account_id, convex)
        logger.info(f"Deleted {sandbox_count} sandboxes before account deletion")

        # TODO: Migrate to Convex - need RPC equivalent for delete_user_immediately
        # result = await client.rpc('delete_user_immediately', {
        #     'p_account_id': account_id,
        #     'p_user_id': user_id
        # }).execute()

        logger.info(f"delete_user_immediately needs migration to Convex")

        return {
            "success": True,
            "message": "Your account and all associated data have been permanently deleted."
        }

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        logger.error(f"Error deleting account immediately: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to delete account: {str(e)}")
