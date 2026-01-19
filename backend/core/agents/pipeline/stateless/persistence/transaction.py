import asyncio
import time
import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Dict, Any, List, Optional, Tuple

from core.utils.logger import logger


@dataclass
class TransactionResult:
    success: bool
    messages_saved: int
    credits_deducted: Decimal
    transaction_id: str
    error: Optional[str] = None
    duration_ms: float = 0


class CreditReservation:
    RESERVATION_TTL = 300
    CLEANUP_INTERVAL = 60
    MAX_RESERVATIONS = 1000

    def __init__(self):
        self._reservations: Dict[str, Dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        self._last_cleanup = time.time()

    async def reserve(
        self,
        account_id: str,
        run_id: str,
        amount: Decimal,
    ) -> str:
        from core.services import redis

        await self._cleanup_expired_if_needed()

        reservation_id = str(uuid.uuid4())
        key = f"credit_reservation:{account_id}:{reservation_id}"

        try:
            await redis.set(
                key,
                str(float(amount)),
                ex=self.RESERVATION_TTL,
            )

            async with self._lock:
                if len(self._reservations) >= self.MAX_RESERVATIONS:
                    logger.warning("[CreditReservation] Max reservations reached, cleaning expired")
                    await self._cleanup_expired()
                
                self._reservations[reservation_id] = {
                    "account_id": account_id,
                    "run_id": run_id,
                    "amount": amount,
                    "created_at": time.time(),
                }

            return reservation_id
        except Exception as e:
            logger.error(f"[CreditReservation] Reserve failed: {e}")
            raise

    async def _cleanup_expired_if_needed(self) -> None:
        now = time.time()
        if now - self._last_cleanup < self.CLEANUP_INTERVAL:
            return
        await self._cleanup_expired()

    async def _cleanup_expired(self) -> int:
        now = time.time()
        self._last_cleanup = now
        expired_count = 0
        
        async with self._lock:
            expired_keys = [
                k for k, v in self._reservations.items()
                if now - v["created_at"] > self.RESERVATION_TTL + 60
            ]
            for k in expired_keys:
                logger.warning(f"[CreditReservation] Cleaning expired reservation: {k}")
                del self._reservations[k]
                expired_count += 1
        
        return expired_count

    async def commit(self, reservation_id: str) -> bool:
        from core.services import redis
        from core.billing.credits.manager import credit_manager

        async with self._lock:
            reservation = self._reservations.pop(reservation_id, None)

        if not reservation:
            return False

        try:
            key = f"credit_reservation:{reservation['account_id']}:{reservation_id}"
            await redis.delete(key)

            await credit_manager.deduct_credits(
                account_id=reservation["account_id"],
                amount=reservation["amount"],
                description=f"Agent run {reservation['run_id']}",
                thread_id=reservation.get("thread_id"),
            )

            return True
        except Exception as e:
            logger.error(f"[CreditReservation] Commit failed: {e}")
            return False

    async def rollback(self, reservation_id: str) -> bool:
        from core.services import redis

        async with self._lock:
            reservation = self._reservations.pop(reservation_id, None)

        if not reservation:
            return False

        try:
            key = f"credit_reservation:{reservation['account_id']}:{reservation_id}"
            await redis.delete(key)
            return True
        except Exception as e:
            logger.error(f"[CreditReservation] Rollback failed: {e}")
            return False

    async def get_reserved_amount(self, account_id: str) -> Decimal:
        total = Decimal("0")
        async with self._lock:
            for reservation in self._reservations.values():
                if reservation["account_id"] == account_id:
                    total += reservation["amount"]
        return total


class TransactionalWriter:
    def __init__(self):
        self._reservations = CreditReservation()

    async def execute_transaction(
        self,
        run_id: str,
        account_id: str,
        thread_id: str,
        messages: List[Dict[str, Any]],
        credit_amount: Decimal,
    ) -> TransactionResult:
        from core.threads import repo as threads_repo
        from core.billing.credits.manager import credit_manager

        start_time = time.time()
        transaction_id = str(uuid.uuid4())
        reservation_id = None

        try:
            if credit_amount > 0:
                reservation_id = await self._reservations.reserve(
                    account_id=account_id,
                    run_id=run_id,
                    amount=credit_amount,
                )

            saved_count = 0
            for msg_data in messages:
                try:
                    await threads_repo.insert_message(
                        thread_id=msg_data["thread_id"],
                        message_type=msg_data["type"],
                        content=msg_data["content"],
                        is_llm_message=msg_data.get("is_llm_message", True),
                        metadata=msg_data.get("metadata"),
                        agent_id=msg_data.get("agent_id"),
                        agent_version_id=msg_data.get("agent_version_id"),
                        message_id=msg_data.get("message_id"),
                    )
                    saved_count += 1
                except Exception as e:
                    logger.error(f"[TransactionalWriter] Message save failed: {e}")
                    if reservation_id:
                        await self._reservations.rollback(reservation_id)
                    raise

            if reservation_id:
                await self._reservations.commit(reservation_id)

            duration_ms = (time.time() - start_time) * 1000

            return TransactionResult(
                success=True,
                messages_saved=saved_count,
                credits_deducted=credit_amount,
                transaction_id=transaction_id,
                duration_ms=duration_ms,
            )

        except Exception as e:
            if reservation_id:
                await self._reservations.rollback(reservation_id)

            duration_ms = (time.time() - start_time) * 1000

            return TransactionResult(
                success=False,
                messages_saved=0,
                credits_deducted=Decimal("0"),
                transaction_id=transaction_id,
                error=str(e),
                duration_ms=duration_ms,
            )

    async def execute_with_saga(
        self,
        run_id: str,
        account_id: str,
        thread_id: str,
        messages: List[Dict[str, Any]],
        credit_amount: Decimal,
    ) -> TransactionResult:
        from core.threads import repo as threads_repo
        from core.billing.credits.manager import credit_manager

        start_time = time.time()
        transaction_id = str(uuid.uuid4())
        saved_message_ids = []

        try:
            for msg_data in messages:
                msg_id = msg_data.get("message_id", str(uuid.uuid4()))
                await threads_repo.insert_message(
                    thread_id=msg_data["thread_id"],
                    message_type=msg_data["type"],
                    content=msg_data["content"],
                    is_llm_message=msg_data.get("is_llm_message", True),
                    metadata=msg_data.get("metadata"),
                    agent_id=msg_data.get("agent_id"),
                    agent_version_id=msg_data.get("agent_version_id"),
                    message_id=msg_id,
                )
                saved_message_ids.append(msg_id)

            if credit_amount > 0:
                await credit_manager.deduct_credits(
                    account_id=account_id,
                    amount=credit_amount,
                    description=f"Agent run {run_id}",
                    thread_id=thread_id,
                )

            duration_ms = (time.time() - start_time) * 1000

            return TransactionResult(
                success=True,
                messages_saved=len(saved_message_ids),
                credits_deducted=credit_amount,
                transaction_id=transaction_id,
                duration_ms=duration_ms,
            )

        except Exception as e:
            logger.error(f"[TransactionalWriter] Saga failed, compensating: {e}")

            for msg_id in saved_message_ids:
                try:
                    await threads_repo.delete_message(msg_id)
                except Exception as del_error:
                    logger.error(f"[TransactionalWriter] Compensation failed for {msg_id}: {del_error}")

            duration_ms = (time.time() - start_time) * 1000

            return TransactionResult(
                success=False,
                messages_saved=0,
                credits_deducted=Decimal("0"),
                transaction_id=transaction_id,
                error=str(e),
                duration_ms=duration_ms,
            )


transactional_writer = TransactionalWriter()
credit_reservation = CreditReservation()
