from fastapi import APIRouter, HTTPException, Depends, Request
from typing import List, Dict, Any, Optional
import uuid
from datetime import datetime, timezone
import json

from services.supabase import DBConnection
from utils.logger import logger
from utils.auth_utils import get_current_user_id_from_jwt

from .models import (
    TriggerCreateRequest,
    TriggerUpdateRequest,
    TriggerResponse,
    TriggerType,
)

router = APIRouter()

db: Optional[DBConnection] = None

TRIGGERS_TABLE = "triggers"
TRIGGER_RUNS_TABLE = "trigger_runs"


# ---------------------------------------------------------------------------
# Initialization
# ---------------------------------------------------------------------------

def initialize(_db: DBConnection):
    global db
    db = _db
    logger.info("Initialized triggers.api with DB connection")


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

async def _get_project_and_account(user_id: str) -> Dict[str, str]:
    """Placeholder – derive account_id/project_id from user context.
    For now, returns dummy project mapping. This should be replaced once the
    app has explicit accounts/projects on the user object.
    """
    # TODO: Implement real logic.
    return {
        "account_id": user_id,
        "project_id": None,
    }


# ---------------------------------------------------------------------------
# Webhook helper utilities
# ---------------------------------------------------------------------------

def _parse_preview_link(link):
    """Return (url, token) tuple from a preview link produced by Sandbox."""
    # Fast path – modern sandbox returns an object with url / token attributes.
    url = getattr(link, "url", None) or str(link)
    token = getattr(link, "token", None)

    # Fallback – parse from the string representation if attributes absent
    if token is None and "token=" in url:
        try:
            token = url.split("token=")[1].split("&")[0].split("'")[0]
        except Exception:
            token = None
    return url, token


async def _create_webhook_resources(
    client,
    *,
    account_id: str,
    name: str,
    description: str,
) -> tuple[str, str]:
    """Create (project, sandbox, thread) trio needed for a webhook trigger.

    Returns (project_id, thread_id). Any failure will attempt best-effort clean-up
    and re-raise as HTTPException so callers don't have to duplicate error
    handling logic.
    """
    from sandbox.sandbox import create_sandbox  # local import to avoid circulars

    project_id = str(uuid.uuid4())

    # 1. Project ---------------------------------------------------------
    try:
        await client.table("projects").insert(
            {
                "project_id": project_id,
                "account_id": account_id,
                "name": f"Webhook: {name}",
                "description": f"Dedicated project for webhook trigger: {description}",
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        ).execute()
    except Exception as e:
        logger.error("Failed creating webhook project: %s", e)
        raise HTTPException(status_code=500, detail="Failed to create webhook project")

    # 2. Sandbox ---------------------------------------------------------
    sandbox_pass = str(uuid.uuid4())
    try:
        sandbox = create_sandbox(sandbox_pass, project_id)
        vnc_link, website_link = sandbox.get_preview_link(6080), sandbox.get_preview_link(8080)
        vnc_url, token = _parse_preview_link(vnc_link)
        website_url, _ = _parse_preview_link(website_link)

        await client.table("projects").update(
            {
                "sandbox": {
                    "id": sandbox.id,
                    "pass": sandbox_pass,
                    "vnc_preview": vnc_url,
                    "sandbox_url": website_url,
                    "token": token,
                }
            }
        ).eq("project_id", project_id).execute()
    except Exception as e:
        # Best effort cleanup before bubbling the error
        logger.error("Error creating sandbox for webhook project: %s", e)
        await client.table("projects").delete().eq("project_id", project_id).execute()
        raise HTTPException(status_code=500, detail="Failed to create sandbox for webhook")

    # 3. Thread ----------------------------------------------------------
    thread_id = str(uuid.uuid4())
    try:
        await client.table("threads").insert(
            {
                "thread_id": thread_id,
                "project_id": project_id,
                "account_id": account_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "metadata": {"webhook_trigger": True, "trigger_name": name},
            }
        ).execute()
    except Exception as e:
        logger.error("Failed to create webhook thread: %s", e)
        await client.table("projects").delete().eq("project_id", project_id).execute()
        raise HTTPException(status_code=500, detail="Failed to create webhook thread")

    return project_id, thread_id


async def _cleanup_webhook_resources(client, project_id: Optional[str]):
    """Best-effort deletion of project & sandbox. Swallows all errors."""
    if not project_id:
        return
    try:
        from sandbox.sandbox import delete_sandbox  # local import to avoid circulars

        project_res = await client.table("projects").select("*").eq("project_id", project_id).execute()
        if project_res.data:
            sandbox_info = project_res.data[0].get("sandbox", {})
            sandbox_id = sandbox_info.get("id")
            if sandbox_id:
                try:
                    await delete_sandbox(sandbox_id)
                    logger.info("Deleted sandbox %s during webhook cleanup", sandbox_id)
                except Exception as e:
                    logger.warning("Failed to delete sandbox %s: %s", sandbox_id, e)

        await client.table("projects").delete().eq("project_id", project_id).execute()
        logger.info("Deleted webhook project %s during cleanup", project_id)
    except Exception as e:
        logger.error("Webhook cleanup failed for project %s: %s", project_id, e)


# ---------------------------------------------------------------------------
# CRUD Endpoints (Authenticated)
# ---------------------------------------------------------------------------

@router.post("/triggers", response_model=TriggerResponse)
async def create_trigger(
    trigger_data: TriggerCreateRequest,
    user_id: str = Depends(get_current_user_id_from_jwt),
):
    if db is None:
        raise HTTPException(status_code=500, detail="Triggers subsystem not initialized")

    ids = await _get_project_and_account(user_id)

    client = await db.client
    
    # For webhook triggers we spin up dedicated infra via helper ----------------
    webhook_project_id: Optional[str] = None
    webhook_thread_id: Optional[str] = None

    if trigger_data.type == TriggerType.webhook:
        try:
            webhook_project_id, webhook_thread_id = await _create_webhook_resources(
                client,
                account_id=ids["account_id"],
                name=trigger_data.name,
                description=trigger_data.description or trigger_data.name,
            )
        except HTTPException:
            raise  # Simply bubble FastAPI errors
        except Exception as e:
            logger.error("Failed to create webhook infra: %s", e)
            raise HTTPException(status_code=500, detail="Failed to create webhook infrastructure")

    # Prepare trigger config
    trigger_config = trigger_data.config.copy() if trigger_data.config else {}
    
    # For webhook triggers, store the dedicated project and thread IDs
    if trigger_data.type == TriggerType.webhook:
        trigger_config.update({
            "project_id": webhook_project_id,
            "thread_id": webhook_thread_id,
            "prompt": trigger_config.get("prompt", "Webhook trigger fired with the following payload:")
        })

    record = {
        "id": str(uuid.uuid4()),
        "account_id": ids["account_id"],
        "project_id": webhook_project_id if trigger_data.type == TriggerType.webhook else ids["project_id"],
        "name": trigger_data.name,
        "description": trigger_data.description,
        "type": trigger_data.type.value,
        "config": trigger_config,
        "enabled": trigger_data.enabled,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "secret": str(uuid.uuid4())[:16] if trigger_data.type == TriggerType.webhook else None,
    }

    try:
        await client.table(TRIGGERS_TABLE).insert(record).execute()
    except Exception as e:
        logger.error("Failed to insert trigger: %s", e)
        # Best effort cleanup on failure
        await _cleanup_webhook_resources(client, webhook_project_id)
        raise HTTPException(status_code=500, detail="Failed to create trigger")

    return TriggerResponse(**record)


@router.get("/triggers", response_model=List[TriggerResponse])
async def list_triggers(user_id: str = Depends(get_current_user_id_from_jwt)):
    if db is None:
        raise HTTPException(status_code=500, detail="Triggers subsystem not initialized")

    ids = await _get_project_and_account(user_id)

    client = await db.client
    try:
        res = await client.table(TRIGGERS_TABLE).select("*").eq("account_id", ids["account_id"]).execute()
    except Exception as e:
        logger.error(f"Failed to fetch triggers: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch triggers")

    return [TriggerResponse(**row) for row in res.data]


@router.get("/triggers/{trigger_id}", response_model=TriggerResponse)
async def get_trigger(trigger_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    if db is None:
        raise HTTPException(status_code=500, detail="Triggers subsystem not initialized")

    client = await db.client
    res = await client.table(TRIGGERS_TABLE).select("*").eq("id", trigger_id).single().execute()
    if res.data is None:
        raise HTTPException(status_code=404, detail="Trigger not found")

    # TODO: access check
    return TriggerResponse(**res.data)


@router.put("/triggers/{trigger_id}", response_model=TriggerResponse)
async def update_trigger(
    trigger_id: str,
    trigger_data: TriggerUpdateRequest,
    user_id: str = Depends(get_current_user_id_from_jwt),
):
    if db is None:
        raise HTTPException(status_code=500, detail="Triggers subsystem not initialized")

    update_dict = {k: v for k, v in trigger_data.dict(exclude_none=True).items()}
    if not update_dict:
        raise HTTPException(status_code=400, detail="No fields to update")

    update_dict["updated_at"] = datetime.now(timezone.utc).isoformat()

    client = await db.client
    await client.table(TRIGGERS_TABLE).update(update_dict).eq("id", trigger_id).execute()

    res = await client.table(TRIGGERS_TABLE).select("*").eq("id", trigger_id).single().execute()
    return TriggerResponse(**res.data)


@router.delete("/triggers/{trigger_id}")
async def delete_trigger(trigger_id: str, user_id: str = Depends(get_current_user_id_from_jwt)):
    if db is None:
        raise HTTPException(status_code=500, detail="Triggers subsystem not initialized")

    client = await db.client
    
    # Get trigger details before deletion to check if cleanup is needed
    trigger_result = await client.table(TRIGGERS_TABLE).select("*").eq("id", trigger_id).single().execute()
    if trigger_result.data is None:
        raise HTTPException(status_code=404, detail="Trigger not found")
    
    trigger = trigger_result.data
    
    # For webhook triggers perform best-effort cleanup -------------------
    if trigger["type"] == "webhook" and trigger.get("config"):
        await _cleanup_webhook_resources(client, trigger.get("config", {}).get("project_id"))
    
    # Delete the trigger
    await client.table(TRIGGERS_TABLE).delete().eq("id", trigger_id).execute()
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Public Webhook Endpoint (Unauthenticated)
# ---------------------------------------------------------------------------

@router.post("/trigger/webhook/{trigger_id}")
async def fire_webhook_trigger(trigger_id: str, request: Request):
    if db is None:
        raise HTTPException(status_code=500, detail="Triggers subsystem not initialized")

    body_bytes = await request.body()
    headers = request.headers

    client = await db.client
    res = await client.table(TRIGGERS_TABLE).select("*").eq("id", trigger_id).single().execute()
    if res.data is None:
        raise HTTPException(status_code=404, detail="Trigger not found")

    trigger = res.data
    if trigger["type"] != "webhook":
        raise HTTPException(status_code=400, detail="Trigger is not of type webhook")
    if not trigger["enabled"]:
        raise HTTPException(status_code=400, detail="Trigger is disabled")

    secret_header = headers.get("X-Trigger-Secret") or headers.get("x-trigger-secret")
    if trigger.get("secret") and secret_header != trigger["secret"]:
        raise HTTPException(status_code=401, detail="Invalid trigger secret")

    # Get webhook configuration
    cfg = trigger.get("config", {}) or {}
    webhook_thread_id = cfg.get("thread_id")
    webhook_project_id = cfg.get("project_id")
    
    if not webhook_thread_id or not webhook_project_id:
        logger.error("Webhook trigger missing required thread_id or project_id in config")
        raise HTTPException(status_code=500, detail="Webhook trigger misconfigured. Missing thread or project information.")

    # -------------------------------------------------------------------
    # Add webhook payload as a new message to the existing thread
    # -------------------------------------------------------------------
    
    # Get webhook payload to include in the message
    webhook_payload = {
        "headers": dict(headers),
        "body": body_bytes.decode("utf-8", errors="ignore"),
        "webhook_url": f"/api/trigger/webhook/{trigger_id}",
        "fired_at": datetime.now(timezone.utc).isoformat()
    }
    
    # Format the user message with webhook context
    prompt = cfg.get("prompt", "Webhook trigger fired with the following payload:")
    user_message_content = f"{prompt}\n\nWebhook Payload:\n```json\n{json.dumps(webhook_payload, indent=2)}\n```"
    
    message_id = str(uuid.uuid4())
    message_payload = {"role": "user", "content": user_message_content}
    
    try:
        await client.table("messages").insert({
            "message_id": message_id,
            "thread_id": webhook_thread_id,
            "type": "user",
            "is_llm_message": True,
            "content": json.dumps(message_payload),
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
        logger.info(f"Added webhook message to thread {webhook_thread_id}")
    except Exception as e:
        logger.error(f"Failed to add webhook message to thread: {e}")
        raise HTTPException(status_code=500, detail="Failed to add webhook message")

    # -------------------------------------------------------------------
    # Launch the agent via existing start_agent endpoint logic
    # -------------------------------------------------------------------

    try:
        # Dynamically import to avoid circular at module import time
        from backend.agent.api import start_agent, AgentStartRequest
    except ImportError:
        # Fallback path if module resolution differs when running inside container
        from agent.api import start_agent, AgentStartRequest  # type: ignore

    # Determine a user_id that belongs to the trigger's account so access checks pass
    account_id = trigger["account_id"]
    user_query = await client.schema("basejump").from_("account_user").select("user_id").eq("account_id", account_id).limit(1).execute()
    if not user_query.data:
        logger.error("No user found for account to launch agent")
        raise HTTPException(status_code=500, detail="No user linked to account for trigger execution")

    trigger_user_id = user_query.data[0]["user_id"]

    start_body = AgentStartRequest(
        model_name=cfg.get("model_name"),
        enable_thinking=cfg.get("enable_thinking", False),
        reasoning_effort=cfg.get("reasoning_effort", "low"),
        stream=False,
        enable_context_manager=cfg.get("enable_context_manager", False),
        agent_id=cfg.get("agent_id"),
    )

    try:
        result = await start_agent(webhook_thread_id, start_body, trigger_user_id)  # type: ignore[arg-type]
        agent_run_id = result.get("agent_run_id")
    except HTTPException as e:
        raise  # propagate upstream
    except Exception as e:
        logger.error(f"Failed to start agent via start_agent: {e}")
        raise HTTPException(status_code=500, detail="Failed to start agent for trigger")

    # -------------------------------------------------------------------
    # Record trigger_run row
    # -------------------------------------------------------------------
    trigger_run_id = str(uuid.uuid4())
    try:
        await client.table(TRIGGER_RUNS_TABLE).insert(
            {
                "id": trigger_run_id,
                "trigger_id": trigger_id,
                "agent_run_id": agent_run_id,
                "status": "queued",
                "fired_at": datetime.now(timezone.utc).isoformat(),
                "debug_payload": {
                    "headers": dict(headers),
                    "body": body_bytes.decode("utf-8", errors="ignore"),
                    "expected_agent_run_id": agent_run_id,
                },
            }
        ).execute()
    except Exception as e:
        logger.error(f"Failed to insert trigger_run: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to create trigger run: {str(e)}")

    return {
        "status": "queued",
        "trigger_run_id": trigger_run_id,
        "agent_run_id": agent_run_id,
    } 