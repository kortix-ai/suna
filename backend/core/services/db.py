from typing import Optional, AsyncIterator, Set
from contextlib import asynccontextmanager
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker, AsyncEngine
from sqlalchemy.pool import NullPool, QueuePool
from sqlalchemy import text
from sqlalchemy.exc import OperationalError, InterfaceError
from core.utils.logger import logger
import os
import asyncio
import re

POSTGRES_POOL_SIZE = int(os.getenv("POSTGRES_POOL_SIZE", "20"))
POSTGRES_MAX_OVERFLOW = int(os.getenv("POSTGRES_MAX_OVERFLOW", "30"))
POSTGRES_POOL_TIMEOUT = int(os.getenv("POSTGRES_POOL_TIMEOUT", "30"))
POSTGRES_POOL_RECYCLE = int(os.getenv("POSTGRES_POOL_RECYCLE", "1800"))
POSTGRES_ECHO = os.getenv("POSTGRES_ECHO", "false").lower() == "true"
POSTGRES_USE_NULLPOOL = os.getenv("POSTGRES_USE_NULLPOOL", "auto")

POSTGRES_STATEMENT_TIMEOUT = int(os.getenv("POSTGRES_STATEMENT_TIMEOUT", "30000"))  # 30s for complex queries
POSTGRES_CONNECT_TIMEOUT = int(os.getenv("POSTGRES_CONNECT_TIMEOUT", "10"))

POSTGRES_MAX_RETRIES = int(os.getenv("POSTGRES_MAX_RETRIES", "3"))
POSTGRES_RETRY_DELAY = float(os.getenv("POSTGRES_RETRY_DELAY", "0.1"))

_VALID_IDENTIFIER = re.compile(r'^[a-zA-Z_][a-zA-Z0-9_]*$')
_VALID_COLUMN_LIST = re.compile(r'^(\*|[a-zA-Z_][a-zA-Z0-9_]*(\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*)$')

_engine: Optional[AsyncEngine] = None
_session_factory: Optional[async_sessionmaker[AsyncSession]] = None

def _get_connection_string() -> str:
    direct_url = os.getenv("DATABASE_URL")
    if direct_url:
        if direct_url.startswith("postgres://"):
            direct_url = direct_url.replace("postgres://", "postgresql://", 1)
        if direct_url.startswith("postgresql://") and "+asyncpg" not in direct_url:
            return direct_url.replace("postgresql://", "postgresql+asyncpg://", 1)
        return direct_url

    pooler_url = os.getenv("DATABASE_POOLER_URL")
    if pooler_url:
        if pooler_url.startswith("postgres://"):
            pooler_url = pooler_url.replace("postgres://", "postgresql://", 1)
        if pooler_url.startswith("postgresql://") and "+asyncpg" not in pooler_url:
            return pooler_url.replace("postgresql://", "postgresql+asyncpg://", 1)
        return pooler_url

    from core.utils.config import config
    supabase_url = config.SUPABASE_URL
    if not supabase_url:
        raise RuntimeError("No database connection configured")

    project_ref = supabase_url.replace("https://", "").split(".")[0]
    password = os.getenv("POSTGRES_PASSWORD")
    if not password:
        raise RuntimeError(
            "Direct Postgres connection requires DATABASE_URL, DATABASE_POOLER_URL, "
            "or POSTGRES_PASSWORD environment variable"
        )

    return f"postgresql+asyncpg://postgres.{project_ref}:{password}@aws-0-us-east-1.pooler.supabase.com:6543/postgres"


def _is_transient_error(error: Exception) -> bool:
    error_str = str(error).lower()
    transient_patterns = [
        "connection reset",
        "connection refused", 
        "connection timed out",
        "server closed the connection",
        "ssl connection has been closed",
        "could not connect to server",
        "remaining connection slots are reserved",
        "too many connections",
        "connection pool exhausted",
        "canceling statement due to statement timeout",
    ]
    return any(pattern in error_str for pattern in transient_patterns)


def _validate_identifier(name: str, context: str = "identifier") -> str:
    if not name or not _VALID_IDENTIFIER.match(name):
        raise ValueError(f"Invalid SQL {context}: {name!r}")
    return name


def _validate_columns(columns: str) -> str:
    columns = columns.strip()
    if not columns or not _VALID_COLUMN_LIST.match(columns):
        raise ValueError(f"Invalid column specification: {columns!r}")
    return columns


def _validate_order_by(order_by: str) -> str:
    parts = [p.strip() for p in order_by.split(",")]
    validated = []
    for part in parts:
        tokens = part.split()
        if not tokens:
            raise ValueError(f"Invalid ORDER BY: {order_by!r}")
        
        col = tokens[0].strip('"')
        if not _VALID_IDENTIFIER.match(col):
            raise ValueError(f"Invalid ORDER BY column: {col!r}")
        
        result = f'"{col}"'
        remaining = " ".join(tokens[1:]).upper()
        
        if remaining:
            allowed = {"ASC", "DESC", "NULLS FIRST", "NULLS LAST", 
                      "ASC NULLS FIRST", "ASC NULLS LAST",
                      "DESC NULLS FIRST", "DESC NULLS LAST"}
            if remaining not in allowed:
                raise ValueError(f"Invalid ORDER BY modifier: {remaining!r}")
            result += f" {remaining}"
        
        validated.append(result)
    
    return ", ".join(validated)


async def init_db() -> None:
    global _engine, _session_factory
    
    if _engine is not None:
        return
    
    dsn = _get_connection_string()
    is_supavisor = "pooler.supabase.com" in dsn or ":6543" in dsn
    
    connect_args = {
        "timeout": POSTGRES_CONNECT_TIMEOUT,
        "command_timeout": POSTGRES_STATEMENT_TIMEOUT / 1000,
        "server_settings": {
            "statement_timeout": str(POSTGRES_STATEMENT_TIMEOUT),
            "lock_timeout": "5000",
        }
    }

    use_nullpool = (
        POSTGRES_USE_NULLPOOL == "true" or
        (POSTGRES_USE_NULLPOOL == "auto" and is_supavisor)
    )
    
    if use_nullpool:
        _engine = create_async_engine(
            dsn,
            poolclass=NullPool,
            echo=POSTGRES_ECHO,
            connect_args=connect_args,
        )
        pool_info = "NullPool (Supavisor transaction mode)" if is_supavisor else "NullPool (explicit)"
    else:
        _engine = create_async_engine(
            dsn,
            poolclass=QueuePool,
            pool_size=POSTGRES_POOL_SIZE,
            max_overflow=POSTGRES_MAX_OVERFLOW,
            pool_timeout=POSTGRES_POOL_TIMEOUT,
            pool_recycle=POSTGRES_POOL_RECYCLE,
            pool_pre_ping=True,
            echo=POSTGRES_ECHO,
            connect_args=connect_args,
        )
        pool_info = f"QueuePool(size={POSTGRES_POOL_SIZE}, max={POSTGRES_POOL_SIZE + POSTGRES_MAX_OVERFLOW})"

    _session_factory = async_sessionmaker(
        _engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autoflush=False,
    )

    timeout_info = f"stmt={POSTGRES_STATEMENT_TIMEOUT}ms, conn={POSTGRES_CONNECT_TIMEOUT}s"
    logger.info(f"✅ Database initialized | {pool_info} | {timeout_info}")


async def close_db() -> None:
    global _engine, _session_factory
    if _engine:
        await _engine.dispose()
        _engine = None
        _session_factory = None
        logger.info("Database connection closed")


@asynccontextmanager
async def get_session() -> AsyncIterator[AsyncSession]:
    if _session_factory is None:
        await init_db()
    
    last_error = None
    for attempt in range(POSTGRES_MAX_RETRIES):
        try:
            async with _session_factory() as session:
                try:
                    yield session
                    return
                except (OperationalError, InterfaceError) as e:
                    await session.rollback()
                    if _is_transient_error(e) and attempt < POSTGRES_MAX_RETRIES - 1:
                        last_error = e
                        delay = POSTGRES_RETRY_DELAY * (2 ** attempt)
                        logger.warning(f"🔄 Transient DB error (attempt {attempt + 1}/{POSTGRES_MAX_RETRIES}), retrying in {delay:.2f}s: {e}")
                        await asyncio.sleep(delay)
                        break
                    raise
                except Exception:
                    await session.rollback()
                    raise
        except (OperationalError, InterfaceError) as e:
            if _is_transient_error(e) and attempt < POSTGRES_MAX_RETRIES - 1:
                last_error = e
                delay = POSTGRES_RETRY_DELAY * (2 ** attempt)
                logger.warning(f"🔄 Transient connection error (attempt {attempt + 1}/{POSTGRES_MAX_RETRIES}), retrying in {delay:.2f}s: {e}")
                await asyncio.sleep(delay)
                continue
            raise
    
    if last_error:
        raise last_error


@asynccontextmanager
async def transaction() -> AsyncIterator[AsyncSession]:
    if _session_factory is None:
        await init_db()
    
    last_error = None
    for attempt in range(POSTGRES_MAX_RETRIES):
        try:
            async with _session_factory() as session:
                async with session.begin():
                    yield session
                    return
        except (OperationalError, InterfaceError) as e:
            if _is_transient_error(e) and attempt < POSTGRES_MAX_RETRIES - 1:
                last_error = e
                delay = POSTGRES_RETRY_DELAY * (2 ** attempt)
                logger.warning(f"🔄 Transient transaction error (attempt {attempt + 1}/{POSTGRES_MAX_RETRIES}), retrying in {delay:.2f}s: {e}")
                await asyncio.sleep(delay)
                continue
            raise
    
    if last_error:
        raise last_error


async def execute(sql: str, params: Optional[dict] = None) -> list:
    async with get_session() as session:
        result = await session.execute(text(sql), params or {})
        return [dict(row._mapping) for row in result.fetchall()]


async def execute_one(sql: str, params: Optional[dict] = None) -> Optional[dict]:
    async with get_session() as session:
        result = await session.execute(text(sql), params or {})
        row = result.fetchone()
        return dict(row._mapping) if row else None


async def execute_scalar(sql: str, params: Optional[dict] = None):
    async with get_session() as session:
        result = await session.execute(text(sql), params or {})
        return result.scalar()


async def execute_mutate(sql: str, params: Optional[dict] = None) -> list:
    async with get_session() as session:
        result = await session.execute(text(sql), params or {})
        await session.commit()
        try:
            return [dict(row._mapping) for row in result.fetchall()]
        except Exception:
            return []


try:
    import orjson
    def _json_dumps(obj) -> str:
        return orjson.dumps(obj).decode('utf-8')
except ImportError:
    import json as _json
    def _json_dumps(obj) -> str:
        return _json.dumps(obj)


class Table:
    def __init__(self, table_name: str):
        self.table_name = _validate_identifier(table_name, "table name")
        self._json_columns: Set[str] = set()
    
    def json_columns(self, *columns: str) -> 'Table':
        for col in columns:
            _validate_identifier(col, "JSON column")
        self._json_columns = set(columns)
        return self
    
    def _validate_filter_keys(self, filters: dict) -> None:
        for key in filters.keys():
            _validate_identifier(key, "filter column")
    
    def _validate_data_keys(self, data: dict) -> None:
        for key in data.keys():
            _validate_identifier(key, "data column")
    
    async def get(self, id_column: str, id_value, columns: str = "*") -> Optional[dict]:
        id_column = _validate_identifier(id_column, "id column")
        columns = _validate_columns(columns)
        
        async with get_session() as session:
            result = await session.execute(
                text(f'SELECT {columns} FROM "{self.table_name}" WHERE "{id_column}" = :id'),
                {"id": id_value}
            )
            row = result.fetchone()
            return dict(row._mapping) if row else None
    
    async def get_by(self, filters: dict, columns: str = "*") -> Optional[dict]:
        self._validate_filter_keys(filters)
        columns = _validate_columns(columns)
        
        where_parts = [f'"{k}" = :f_{k}' for k in filters.keys()]
        params = {f"f_{k}": v for k, v in filters.items()}
        
        async with get_session() as session:
            result = await session.execute(
                text(f'SELECT {columns} FROM "{self.table_name}" WHERE {" AND ".join(where_parts)} LIMIT 1'),
                params
            )
            row = result.fetchone()
            return dict(row._mapping) if row else None
    
    async def list(
        self,
        filters: Optional[dict] = None,
        columns: str = "*",
        order_by: Optional[str] = None,
        limit: int = 100,
        offset: int = 0
    ) -> list:
        columns = _validate_columns(columns)
        params: dict = {"limit": min(limit, 1000), "offset": offset}
        where_clause = ""
        
        if filters:
            self._validate_filter_keys(filters)
            where_parts = [f'"{k}" = :f_{k}' for k in filters.keys()]
            params.update({f"f_{k}": v for k, v in filters.items()})
            where_clause = f"WHERE {' AND '.join(where_parts)}"
        
        order_clause = f"ORDER BY {_validate_order_by(order_by)}" if order_by else ""
        
        async with get_session() as session:
            result = await session.execute(
                text(f'SELECT {columns} FROM "{self.table_name}" {where_clause} {order_clause} LIMIT :limit OFFSET :offset'),
                params
            )
            return [dict(row._mapping) for row in result.fetchall()]
    
    async def count(self, filters: Optional[dict] = None) -> int:
        params: dict = {}
        where_clause = ""
        
        if filters:
            self._validate_filter_keys(filters)
            where_parts = [f'"{k}" = :f_{k}' for k in filters.keys()]
            params.update({f"f_{k}": v for k, v in filters.items()})
            where_clause = f"WHERE {' AND '.join(where_parts)}"
        
        async with get_session() as session:
            result = await session.execute(
                text(f'SELECT COUNT(*) FROM "{self.table_name}" {where_clause}'),
                params
            )
            return result.scalar() or 0
    
    async def insert(self, data: dict) -> Optional[dict]:
        self._validate_data_keys(data)
        data = self._prepare_json_data(data)
        columns = list(data.keys())
        col_list = ", ".join(f'"{c}"' for c in columns)
        placeholders = [f":{c}::jsonb" if c in self._json_columns else f":{c}" for c in columns]
        
        async with get_session() as session:
            result = await session.execute(
                text(f'INSERT INTO "{self.table_name}" ({col_list}) VALUES ({", ".join(placeholders)}) RETURNING *'),
                data
            )
            await session.commit()
            row = result.fetchone()
            return dict(row._mapping) if row else None
    
    async def update(self, id_column: str, id_value, data: dict) -> Optional[dict]:
        id_column = _validate_identifier(id_column, "id column")
        if not data:
            return await self.get(id_column, id_value)
        
        self._validate_data_keys(data)
        data = self._prepare_json_data(data)
        set_parts = [f'"{k}" = :{k}::jsonb' if k in self._json_columns else f'"{k}" = :{k}' for k in data.keys()]
        params = {**data, "id": id_value}
        
        async with get_session() as session:
            result = await session.execute(
                text(f'UPDATE "{self.table_name}" SET {", ".join(set_parts)} WHERE "{id_column}" = :id RETURNING *'),
                params
            )
            await session.commit()
            row = result.fetchone()
            return dict(row._mapping) if row else None
    
    async def upsert(self, conflict_column: str, data: dict) -> Optional[dict]:
        conflict_column = _validate_identifier(conflict_column, "conflict column")
        self._validate_data_keys(data)
        data = self._prepare_json_data(data)
        columns = list(data.keys())
        col_list = ", ".join(f'"{c}"' for c in columns)
        placeholders = [f":{c}::jsonb" if c in self._json_columns else f":{c}" for c in columns]
        update_cols = [c for c in columns if c != conflict_column]
        update_parts = [f'"{c}" = EXCLUDED."{c}"' for c in update_cols]
        
        async with get_session() as session:
            result = await session.execute(
                text(f'''
                    INSERT INTO "{self.table_name}" ({col_list}) 
                    VALUES ({", ".join(placeholders)})
                    ON CONFLICT ("{conflict_column}") DO UPDATE SET {", ".join(update_parts)}
                    RETURNING *
                '''),
                data
            )
            await session.commit()
            row = result.fetchone()
            return dict(row._mapping) if row else None
    
    async def delete(self, id_column: str, id_value) -> bool:
        id_column = _validate_identifier(id_column, "id column")
        
        async with get_session() as session:
            result = await session.execute(
                text(f'DELETE FROM "{self.table_name}" WHERE "{id_column}" = :id RETURNING "{id_column}"'),
                {"id": id_value}
            )
            await session.commit()
            return result.fetchone() is not None
    
    async def delete_by(self, filters: dict) -> int:
        self._validate_filter_keys(filters)
        where_parts = [f'"{k}" = :f_{k}' for k in filters.keys()]
        params = {f"f_{k}": v for k, v in filters.items()}
        
        async with get_session() as session:
            result = await session.execute(
                text(f'DELETE FROM "{self.table_name}" WHERE {" AND ".join(where_parts)}'),
                params
            )
            await session.commit()
            return result.rowcount
    
    def _prepare_json_data(self, data: dict) -> dict:
        result = {}
        for k, v in data.items():
            if k in self._json_columns and isinstance(v, (dict, list)):
                result[k] = _json_dumps(v)
            else:
                result[k] = v
        return result


def table(name: str) -> Table:
    return Table(name)
