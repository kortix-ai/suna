"""Connectivity checks for external infrastructure dependencies."""

from dataclasses import dataclass
from typing import List
import asyncio

import httpx
from redis import asyncio as aioredis

from core.utils.config import config
from core.utils.logger import logger


@dataclass
class IntegrationCheckResult:
    service: str
    status: str
    detail: str


async def _check_redis() -> IntegrationCheckResult:
    host = getattr(config, "REDIS_HOST", None)
    port = getattr(config, "REDIS_PORT", None)

    if not host or not port:
        return IntegrationCheckResult("redis", "skipped", "Redis host/port not configured")

    try:
        client = aioredis.Redis(
            host=host,
            port=port,
            password=getattr(config, "REDIS_PASSWORD", None),
            ssl=bool(getattr(config, "REDIS_SSL", False)),
        )
        await client.ping()
        await client.close()
        return IntegrationCheckResult("redis", "ok", f"Connected to {host}:{port}")
    except Exception as exc:  # pragma: no cover - defensive logging
        logger.error("Redis connectivity check failed", exc_info=True)
        return IntegrationCheckResult("redis", "error", str(exc))


async def _check_supabase() -> IntegrationCheckResult:
    url = getattr(config, "SUPABASE_URL", None)
    if not url:
        return IntegrationCheckResult("supabase", "skipped", "SUPABASE_URL not configured")

    health_url = f"{url.rstrip('/')}/auth/v1/health"
    headers = {}
    anon_key = getattr(config, "SUPABASE_ANON_KEY", None)
    if anon_key:
        headers["apikey"] = anon_key

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(health_url, headers=headers)
        if response.status_code < 400:
            return IntegrationCheckResult("supabase", "ok", f"HTTP {response.status_code}")
        detail = response.text.strip()[:120]
        return IntegrationCheckResult("supabase", "error", f"HTTP {response.status_code}: {detail}")
    except httpx.HTTPError as exc:
        logger.error("Supabase connectivity check failed", exc_info=True)
        return IntegrationCheckResult("supabase", "error", str(exc))


async def _check_daytona() -> IntegrationCheckResult:
    url = getattr(config, "DAYTONA_SERVER_URL", None)
    api_key = getattr(config, "DAYTONA_API_KEY", None)

    if not url or not api_key:
        return IntegrationCheckResult("daytona", "skipped", "Daytona API key or server URL not configured")

    headers = {"Authorization": f"Bearer {api_key}"}
    base = url.rstrip("/")
    paths = ["/health", "/status", ""]
    last_error = "request failed"

    async with httpx.AsyncClient(timeout=5) as client:
        for path in paths:
            target = f"{base}{path}"
            try:
                response = await client.get(target, headers=headers)
            except httpx.HTTPError as exc:
                last_error = str(exc)
                continue

            if response.status_code < 400:
                return IntegrationCheckResult("daytona", "ok", f"{target} -> {response.status_code}")

            last_error = f"HTTP {response.status_code}: {response.text.strip()[:120]}"

    logger.error("Daytona connectivity check failed: %s", last_error)
    return IntegrationCheckResult("daytona", "error", last_error)


async def run_checks() -> List[IntegrationCheckResult]:
    """Run all integration checks concurrently."""
    results = await asyncio.gather(
        _check_redis(),
        _check_supabase(),
        _check_daytona(),
    )
    return list(results)


def _status_icon(status: str) -> str:
    if status == "ok":
        return "✅"
    if status == "skipped":
        return "⚠️"
    return "❌"


def print_results(results: List[IntegrationCheckResult]) -> None:
    for result in results:
        icon = _status_icon(result.status)
        print(f"{icon} {result.service}: {result.detail}")


if __name__ == "__main__":
    results = asyncio.run(run_checks())
    print_results(results)
