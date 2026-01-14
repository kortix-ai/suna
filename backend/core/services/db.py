import os
import re
import asyncio
import uuid
from datetime import datetime
from typing import Optional, AsyncIterator, Set, Dict, Any, List
from contextlib import asynccontextmanager
from urllib.parse import urlparse, urlunparse, quote, unquote

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker, AsyncEngine
from sqlalchemy.pool import NullPool, AsyncAdaptedQueuePool
from sqlalchemy.exc import OperationalError, InterfaceError

from core.utils.config import EnvMode

from psycopg.types.json import set_json_dumps, set_json_loads
from core.utils.logger import logger

try:
    import orjson
    _json_serialize = lambda obj: orjson.dumps(obj).decode('utf-8')
    _json_deserialize = orjson.loads
except ImportError:
    import json
    _json_serialize = json.dumps
    _json_deserialize = json.loads

set_json_dumps(_json_serialize)
set_json_loads(_json_deserialize)

from core.utils.config import config, EnvMode

def _get_db_config():
    """
    Database connection pool configuration.
    
    UNIFIED CONFIG for staging/production to avoid environment-specific issues.
    Pool sizes are conservative because:
    - Supavisor (port 6543) uses NullPool anyway (auto-detected)
    - Direct connections (port 5432) need small pools to stay within Supabase limits
    
    With 8 workers per container (production):
    - pool_size=3 × 8 workers = 24 base connections
    - max_overflow=7 × 8 workers = 56 overflow
    - Total max = 80 connections per container (safe for Supabase Pro limits ~200)
    
    PERFORMANCE OPTIMIZATIONS (Jan 2026):
    - Increased pool_timeout from 10s to 30s to handle burst traffic
    - Increased max_overflow from 5 to 7 for better burst handling
    - Increased connect_timeout for cloud DB reliability
    """
    if config.ENV_MODE == EnvMode.LOCAL:
        return {
            "pool_size": 3,
            "max_overflow": 5,
            "pool_timeout": 10,
            "pool_recycle": 300,
            "statement_timeout": 15000,
            "connect_timeout": 5,
        }
    else:
        # Unified config for staging AND production
        return {
            "pool_size": 3,           # 3 per worker (conservative)
            "max_overflow": 7,        # Allow burst to 10 per worker (increased from 5)
            "pool_timeout": 30,       # Wait up to 30s for connection (increased from 10)
            "pool_recycle": 300,      # Recycle connections every 5 min
            "statement_timeout": 30000,  # 30s query timeout
            "connect_timeout": 15,    # 15s connection timeout (increased from 10)
        }

_db_config = _get_db_config()

POOL_SIZE = _db_config["pool_size"]
MAX_OVERFLOW = _db_config["max_overflow"] 
POOL_TIMEOUT = _db_config["pool_timeout"]
POOL_RECYCLE = _db_config["pool_recycle"]
STATEMENT_TIMEOUT = _db_config["statement_timeout"]
CONNECT_TIMEOUT = _db_config["connect_timeout"]
MAX_RETRIES = 2
RETRY_DELAY = float(os.getenv("POSTGRES_RETRY_DELAY", "0.1"))
USE_NULLPOOL = os.getenv("POSTGRES_USE_NULLPOOL", "auto")
ECHO = os.getenv("POSTGRES_ECHO", "false").lower() == "true"

_IDENTIFIER_RE = re.compile(r'^[a-zA-Z_][a-zA-Z0-9_]*$')
_COLUMN_LIST_RE = re.compile(r'^(\*|[a-zA-Z_][a-zA-Z0-9_]*(\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*)$')

_engine: Optional[AsyncEngine] = None
_session_factory: Optional[async_sessionmaker[AsyncSession]] = None

# Read replica support
_read_engine: Optional[AsyncEngine] = None
_read_session_factory: Optional[async_sessionmaker[AsyncSession]] = None
_has_read_replica: bool = False

# Usage stats for monitoring (simple counters, thread-safe via GIL)
_stats = {
    "primary_reads": 0,
    "replica_reads": 0,
    "replica_fallbacks": 0,  # Times we fell back to primary due to replica failure
}

TRANSIENT_ERRORS = (
    "connection reset", "connection refused", "connection timed out",
    "server closed the connection", "ssl connection has been closed",
    "could not connect to server", "remaining connection slots are reserved",
    "too many connections", "connection pool exhausted",
    "canceling statement due to statement timeout",
)


def serialize_row(row: Dict[str, Any]) -> Dict[str, Any]:
    from decimal import Decimal
    result = {}
    for k, v in row.items():
        if isinstance(v, uuid.UUID):
            result[k] = str(v)
        elif isinstance(v, datetime):
            result[k] = v.isoformat()
        elif isinstance(v, Decimal):
            result[k] = float(v)
        else:
            result[k] = v
    return result

    
def serialize_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [serialize_row(row) for row in rows]


def _get_dsn() -> str:
    """Get primary database connection string (for writes)."""
    url = os.getenv("DATABASE_URL") or os.getenv("DATABASE_POOLER_URL")
    
    if url:
        # Normalize the URL to ensure password is URL-encoded
        # This handles special characters like @, :, / in passwords
        # Also handles double-encoded passwords (decodes until no % sequences remain, then re-encodes once)
        try:
            parsed = urlparse(url)
            if parsed.password:
                # Decode password until no more URL-encoded sequences remain (handles double/triple encoding)
                decoded_password = parsed.password
                while '%' in decoded_password:
                    try:
                        new_decoded = unquote(decoded_password)
                        if new_decoded == decoded_password:
                            break  # No more decoding possible
                        decoded_password = new_decoded
                    except Exception:
                        break  # Stop if decoding fails
                
                # URL-encode password once (handles special characters like @, :, /)
                encoded_password = quote(decoded_password, safe='')
                netloc = f"{parsed.username}:{encoded_password}@{parsed.hostname}"
                if parsed.port:
                    netloc += f":{parsed.port}"
                url = urlunparse((
                    parsed.scheme,
                    netloc,
                    parsed.path,
                    parsed.params,
                    parsed.query,
                    parsed.fragment
                ))
        except Exception:
            # If parsing fails, continue with original URL
            pass
        
        if "@" in url:
            masked = url.split("@")[0][:40] + "...@" + url.split("@")[-1]
            logger.info(f"🔌 Database URL: {masked}")     
        
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql://", 1)
        if "+asyncpg" in url:
            url = url.replace("+asyncpg", "+psycopg")
        elif "+psycopg" not in url:
            url = url.replace("postgresql://", "postgresql+psycopg://", 1)
        return url
    
    from core.utils.config import config
    if not config.SUPABASE_URL:
        raise RuntimeError("No database connection configured")
    
    project_ref = config.SUPABASE_URL.replace("https://", "").split(".")[0]
    password = os.getenv("POSTGRES_PASSWORD")
    if not password:
        raise RuntimeError("DATABASE_URL, DATABASE_POOLER_URL, or POSTGRES_PASSWORD required")
    
    # URL-encode password when constructing URL from components
    encoded_password = quote(password, safe='')
    return f"postgresql+psycopg://postgres.{project_ref}:{encoded_password}@aws-0-us-east-1.pooler.supabase.com:6543/postgres"


def _get_read_replica_dsn() -> Optional[str]:
    """
    Get read replica database connection string (for reads).
    Returns None if no read replica is configured.
    """
    url = os.getenv("DATABASE_READ_REPLICA_URL")
    
    if not url:
        return None
    
    # Normalize the URL to ensure password is URL-encoded
    # This handles special characters like @, :, / in passwords
    # Also handles double-encoded passwords (decodes until no % sequences remain, then re-encodes once)
    try:
        parsed = urlparse(url)
        if parsed.password:
            # Decode password until no more URL-encoded sequences remain (handles double/triple encoding)
            decoded_password = parsed.password
            while '%' in decoded_password:
                try:
                    new_decoded = unquote(decoded_password)
                    if new_decoded == decoded_password:
                        break  # No more decoding possible
                    decoded_password = new_decoded
                except Exception:
                    break  # Stop if decoding fails
            
            # URL-encode password once (handles special characters like @, :, /)
            encoded_password = quote(decoded_password, safe='')
            netloc = f"{parsed.username}:{encoded_password}@{parsed.hostname}"
            if parsed.port:
                netloc += f":{parsed.port}"
            url = urlunparse((
                parsed.scheme,
                netloc,
                parsed.path,
                parsed.params,
                parsed.query,
                parsed.fragment
            ))
    except Exception:
        # If parsing fails, continue with original URL
        pass
    
    if "@" in url:
        masked = url.split("@")[0][:40] + "...@" + url.split("@")[-1]
        logger.info(f"🔌 Read Replica URL: {masked}")
    
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    if "+asyncpg" in url:
        url = url.replace("+asyncpg", "+psycopg")
    elif "+psycopg" not in url:
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


def _is_transient(e: Exception) -> bool:
    return any(p in str(e).lower() for p in TRANSIENT_ERRORS)


def has_read_replica() -> bool:
    """Check if read replica is configured and available."""
    return _has_read_replica


def get_db_stats() -> Dict[str, Any]:
    """
    Get database connection statistics for monitoring.
    
    Returns:
        Dict with keys:
        - has_read_replica: bool
        - primary_reads: int - queries executed on primary
        - replica_reads: int - queries executed on replica
        - replica_fallbacks: int - times replica failed and we fell back to primary
        - replica_usage_pct: float - percentage of reads going to replica
    """
    total_reads = _stats["primary_reads"] + _stats["replica_reads"]
    replica_pct = (_stats["replica_reads"] / total_reads * 100) if total_reads > 0 else 0.0
    
    return {
        "has_read_replica": _has_read_replica,
        "primary_reads": _stats["primary_reads"],
        "replica_reads": _stats["replica_reads"],
        "replica_fallbacks": _stats["replica_fallbacks"],
        "replica_usage_pct": round(replica_pct, 2),
        "total_reads": total_reads,
    }


def _validate_identifier(name: str, ctx: str = "identifier") -> str:
    if not name or not _IDENTIFIER_RE.match(name):
        raise ValueError(f"Invalid SQL {ctx}: {name!r}")
    return name


def _validate_columns(cols: str) -> str:
    cols = cols.strip()
    if not cols or not _COLUMN_LIST_RE.match(cols):
        raise ValueError(f"Invalid column specification: {cols!r}")
    return cols


def _validate_order_by(order_by: str) -> str:
    allowed_modifiers = {
        "ASC", "DESC", "NULLS FIRST", "NULLS LAST",
        "ASC NULLS FIRST", "ASC NULLS LAST", "DESC NULLS FIRST", "DESC NULLS LAST"
    }
    validated = []
    for part in order_by.split(","):
        tokens = part.split()
        if not tokens:
            raise ValueError(f"Invalid ORDER BY: {order_by!r}")
        col = tokens[0].strip('"')
        if not _IDENTIFIER_RE.match(col):
            raise ValueError(f"Invalid ORDER BY column: {col!r}")
        result = f'"{col}"'
        modifier = " ".join(tokens[1:]).upper()
        if modifier:
            if modifier not in allowed_modifiers:
                raise ValueError(f"Invalid ORDER BY modifier: {modifier!r}")
            result += f" {modifier}"
        validated.append(result)
    return ", ".join(validated)


async def init_db() -> None:
    global _engine, _session_factory, _read_engine, _read_session_factory, _has_read_replica
    if _engine is not None:
        return
    
    # Initialize primary database (for writes)
    dsn = _get_dsn()
    is_supavisor = "pooler.supabase.com" in dsn or ":6543" in dsn
    
    connect_args = {
        "connect_timeout": CONNECT_TIMEOUT,
        "prepare_threshold": None,
    }
    if not is_supavisor:
        connect_args["options"] = f"-c statement_timeout={STATEMENT_TIMEOUT} -c lock_timeout=5000"
    
    use_nullpool = USE_NULLPOOL == "true" or (USE_NULLPOOL == "auto" and is_supavisor)
    execution_opts = {"prepared_statement_cache_size": 0}
    
    if use_nullpool:
        _engine = create_async_engine(
            dsn,
            poolclass=NullPool,
            echo=ECHO,
            connect_args=connect_args,
            execution_options=execution_opts,
        )
        pool_info = "NullPool"
    else:
        _engine = create_async_engine(
            dsn,
            poolclass=AsyncAdaptedQueuePool,
            pool_size=POOL_SIZE,
            max_overflow=MAX_OVERFLOW,
            pool_timeout=POOL_TIMEOUT,
            pool_recycle=POOL_RECYCLE,
            pool_pre_ping=True,
            echo=ECHO,
            connect_args=connect_args,
            execution_options=execution_opts,
        )
        pool_info = f"Pool(size={POOL_SIZE}, max={POOL_SIZE + MAX_OVERFLOW})"
    
    _session_factory = async_sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False, autoflush=False)
    
    # Initialize read replica (optional)
    read_dsn = _get_read_replica_dsn()
    if read_dsn:
        _has_read_replica = True
        is_supavisor_read = "pooler.supabase.com" in read_dsn or ":6543" in read_dsn
        
        connect_args_read = {
            "connect_timeout": CONNECT_TIMEOUT,
            "prepare_threshold": None,
        }
        if not is_supavisor_read:
            connect_args_read["options"] = f"-c statement_timeout={STATEMENT_TIMEOUT} -c lock_timeout=5000"
        
        use_nullpool_read = USE_NULLPOOL == "true" or (USE_NULLPOOL == "auto" and is_supavisor_read)
        
        if use_nullpool_read:
            _read_engine = create_async_engine(
                read_dsn,
                poolclass=NullPool,
                echo=ECHO,
                connect_args=connect_args_read,
                execution_options=execution_opts,
            )
            read_pool_info = "NullPool"
        else:
            _read_engine = create_async_engine(
                read_dsn,
                poolclass=AsyncAdaptedQueuePool,
                pool_size=POOL_SIZE,
                max_overflow=MAX_OVERFLOW,
                pool_timeout=POOL_TIMEOUT,
                pool_recycle=POOL_RECYCLE,
                pool_pre_ping=True,
                echo=ECHO,
                connect_args=connect_args_read,
                execution_options=execution_opts,
            )
            read_pool_info = f"Pool(size={POOL_SIZE}, max={POOL_SIZE + MAX_OVERFLOW})"
        
        _read_session_factory = async_sessionmaker(_read_engine, class_=AsyncSession, expire_on_commit=False, autoflush=False)
        
        # Validate read replica connection
        try:
            async with _read_engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            logger.info(f"✅ Database initialized | Primary: {pool_info} | Read Replica: {read_pool_info} ✓ | timeout={STATEMENT_TIMEOUT}ms")
        except Exception as e:
            logger.warning(f"⚠️ Read replica connection test failed: {e}. Will fallback to primary for reads.")
            # Keep _has_read_replica = True so we can retry later, but log the warning
            logger.info(f"✅ Database initialized | Primary: {pool_info} | Read Replica: CONFIGURED BUT UNREACHABLE | timeout={STATEMENT_TIMEOUT}ms")
    else:
        _has_read_replica = False
        logger.info(f"✅ Database initialized | {pool_info} | timeout={STATEMENT_TIMEOUT}ms | No read replica configured")


async def close_db() -> None:
    global _engine, _session_factory, _read_engine, _read_session_factory, _has_read_replica
    if _engine:
        await _engine.dispose()
        _engine = None
        _session_factory = None
    if _read_engine:
        await _read_engine.dispose()
        _read_engine = None
        _read_session_factory = None
        _has_read_replica = False
    logger.info("Database connection closed")


@asynccontextmanager
async def get_session() -> AsyncIterator[AsyncSession]:
    """Get a database session (primary database - for writes)."""
    if _session_factory is None:
        await init_db()
    
    for attempt in range(MAX_RETRIES):
        try:
            async with _session_factory() as session:
                try:
                    yield session
                    return
                except (OperationalError, InterfaceError) as e:
                    await session.rollback()
                    if _is_transient(e) and attempt < MAX_RETRIES - 1:
                        await asyncio.sleep(RETRY_DELAY * (2 ** attempt))
                        break
                    raise
                except Exception:
                    await session.rollback()
                    raise
        except (OperationalError, InterfaceError) as e:
            if _is_transient(e) and attempt < MAX_RETRIES - 1:
                await asyncio.sleep(RETRY_DELAY * (2 ** attempt))
                continue
            raise


@asynccontextmanager
async def get_read_session() -> AsyncIterator[AsyncSession]:
    """
    Get a database session for read operations.
    Uses read replica if configured, otherwise falls back to primary.
    
    FAILOVER: If read replica connection fails, automatically falls back to primary.
    """
    if _session_factory is None:
        await init_db()
    
    # Use read replica if available, otherwise fall back to primary
    use_replica = _has_read_replica and _read_session_factory is not None
    factory = _read_session_factory if use_replica else _session_factory
    
    for attempt in range(MAX_RETRIES):
        try:
            async with factory() as session:
                try:
                    # Track usage
                    if use_replica:
                        _stats["replica_reads"] += 1
                    else:
                        _stats["primary_reads"] += 1
                    yield session
                    return
                except (OperationalError, InterfaceError) as e:
                    await session.rollback()
                    if _is_transient(e) and attempt < MAX_RETRIES - 1:
                        await asyncio.sleep(RETRY_DELAY * (2 ** attempt))
                        break
                    raise
                except Exception:
                    await session.rollback()
                    raise
        except (OperationalError, InterfaceError) as e:
            # If read replica fails, try to fallback to primary
            if use_replica and attempt == MAX_RETRIES - 1:
                logger.warning(f"⚠️ Read replica unavailable, falling back to primary: {e}")
                _stats["replica_fallbacks"] += 1
                # Fallback to primary on final attempt
                try:
                    async with _session_factory() as session:
                        _stats["primary_reads"] += 1
                        yield session
                        return
                except Exception as fallback_error:
                    logger.error(f"❌ Primary fallback also failed: {fallback_error}")
                    raise
            
            if _is_transient(e) and attempt < MAX_RETRIES - 1:
                await asyncio.sleep(RETRY_DELAY * (2 ** attempt))
                continue
            raise


@asynccontextmanager
async def transaction() -> AsyncIterator[AsyncSession]:
    if _session_factory is None:
        await init_db()
    
    for attempt in range(MAX_RETRIES):
        try:
            async with _session_factory() as session:
                async with session.begin():
                    yield session
                    return
        except (OperationalError, InterfaceError) as e:
            if _is_transient(e) and attempt < MAX_RETRIES - 1:
                await asyncio.sleep(RETRY_DELAY * (2 ** attempt))
                continue
            raise


def _prep_params(params: Optional[dict]) -> dict:
    if not params:
        return {}
    result = {}
    for k, v in params.items():
        if isinstance(v, dict):
            result[k] = _json_serialize(v)
        elif isinstance(v, list) and v and isinstance(v[0], dict):
            result[k] = _json_serialize(v)
        else:
            result[k] = v
    return result


async def execute(sql: str, params: Optional[dict] = None) -> List[dict]:
    """Execute query on primary database (use for writes or when consistency needed)."""
    async with get_session() as session:
        result = await session.execute(text(sql), _prep_params(params))
        return [dict(row._mapping) for row in result.fetchall()]


async def execute_read(sql: str, params: Optional[dict] = None) -> List[dict]:
    """Execute read-only query on read replica (if configured) or primary."""
    async with get_read_session() as session:
        result = await session.execute(text(sql), _prep_params(params))
        return [dict(row._mapping) for row in result.fetchall()]


async def execute_one(sql: str, params: Optional[dict] = None, commit: bool = False) -> Optional[dict]:
    """Execute query on primary database returning single row."""
    async with get_session() as session:
        result = await session.execute(text(sql), _prep_params(params))
        if commit:
            await session.commit()
        row = result.fetchone()
        return dict(row._mapping) if row else None


async def execute_one_read(sql: str, params: Optional[dict] = None) -> Optional[dict]:
    """Execute read-only query on read replica (if configured) returning single row."""
    async with get_read_session() as session:
        result = await session.execute(text(sql), _prep_params(params))
        row = result.fetchone()
        return dict(row._mapping) if row else None


async def execute_scalar(sql: str, params: Optional[dict] = None):
    """Execute query on primary database returning scalar value."""
    async with get_session() as session:
        result = await session.execute(text(sql), _prep_params(params))
        return result.scalar()


async def execute_scalar_read(sql: str, params: Optional[dict] = None):
    """Execute read-only query on read replica (if configured) returning scalar value."""
    async with get_read_session() as session:
        result = await session.execute(text(sql), _prep_params(params))
        return result.scalar()


async def execute_mutate(sql: str, params: Optional[dict] = None) -> List[dict]:
    async with get_session() as session:
        result = await session.execute(text(sql), _prep_params(params))
        await session.commit()
        try:
            return [dict(row._mapping) for row in result.fetchall()]
        except Exception:
            return []


class Table:
    def __init__(self, name: str, use_read_replica: bool = True):
        """
        Initialize a Table helper.
        
        Args:
            name: Table name
            use_read_replica: If True, SELECT queries will use read replica when available.
                            Set to False if you need strong consistency (read-after-write).
        """
        self.name = _validate_identifier(name, "table name")
        self._json_cols: Set[str] = set()
        self.use_read_replica = use_read_replica
    
    def json_columns(self, *cols: str) -> 'Table':
        for c in cols:
            _validate_identifier(c, "JSON column")
        self._json_cols = set(cols)
        return self
    
    def _check_keys(self, d: dict, ctx: str) -> None:
        for k in d:
            _validate_identifier(k, ctx)
    
    def _prep_json(self, data: dict) -> dict:
        return {
            k: _json_serialize(v) if k in self._json_cols and isinstance(v, (dict, list)) else v
            for k, v in data.items()
        }
    
    async def get(self, id_col: str, id_val, cols: str = "*", use_replica: Optional[bool] = None) -> Optional[dict]:
        """
        Get a single row by ID.
        
        Args:
            id_col: ID column name
            id_val: ID value
            cols: Columns to select
            use_replica: Override table's use_read_replica setting for this query
        """
        id_col = _validate_identifier(id_col, "id column")
        cols = _validate_columns(cols)
        should_use_replica = use_replica if use_replica is not None else self.use_read_replica
        session_ctx = get_read_session() if should_use_replica else get_session()
        
        async with session_ctx as s:
            r = await s.execute(text(f'SELECT {cols} FROM "{self.name}" WHERE "{id_col}" = :id'), {"id": id_val})
            row = r.fetchone()
            return dict(row._mapping) if row else None
    
    async def get_by(self, filters: dict, cols: str = "*", use_replica: Optional[bool] = None) -> Optional[dict]:
        """
        Get a single row by filters.
        
        Args:
            filters: Filter conditions
            cols: Columns to select
            use_replica: Override table's use_read_replica setting for this query
        """
        self._check_keys(filters, "filter column")
        cols = _validate_columns(cols)
        where = " AND ".join(f'"{k}" = :f_{k}' for k in filters)
        params = {f"f_{k}": v for k, v in filters.items()}
        should_use_replica = use_replica if use_replica is not None else self.use_read_replica
        session_ctx = get_read_session() if should_use_replica else get_session()
        
        async with session_ctx as s:
            r = await s.execute(text(f'SELECT {cols} FROM "{self.name}" WHERE {where} LIMIT 1'), params)
            row = r.fetchone()
            return dict(row._mapping) if row else None
    
    async def list(self, filters: Optional[dict] = None, cols: str = "*", order_by: Optional[str] = None, 
                   limit: int = 100, offset: int = 0, use_replica: Optional[bool] = None) -> List[dict]:
        """
        List rows with optional filters.
        
        Args:
            filters: Filter conditions
            cols: Columns to select
            order_by: Order by clause
            limit: Maximum rows to return
            offset: Offset for pagination
            use_replica: Override table's use_read_replica setting for this query
        """
        cols = _validate_columns(cols)
        params: dict = {"limit": min(limit, 1000), "offset": offset}
        where = ""
        if filters:
            self._check_keys(filters, "filter column")
            where = "WHERE " + " AND ".join(f'"{k}" = :f_{k}' for k in filters)
            params.update({f"f_{k}": v for k, v in filters.items()})
        order = f"ORDER BY {_validate_order_by(order_by)}" if order_by else ""
        should_use_replica = use_replica if use_replica is not None else self.use_read_replica
        session_ctx = get_read_session() if should_use_replica else get_session()
        
        async with session_ctx as s:
            r = await s.execute(text(f'SELECT {cols} FROM "{self.name}" {where} {order} LIMIT :limit OFFSET :offset'), params)
            return [dict(row._mapping) for row in r.fetchall()]
    
    async def count(self, filters: Optional[dict] = None, use_replica: Optional[bool] = None) -> int:
        """
        Count rows with optional filters.
        
        Args:
            filters: Filter conditions
            use_replica: Override table's use_read_replica setting for this query
        """
        params: dict = {}
        where = ""
        if filters:
            self._check_keys(filters, "filter column")
            where = "WHERE " + " AND ".join(f'"{k}" = :f_{k}' for k in filters)
            params.update({f"f_{k}": v for k, v in filters.items()})
        should_use_replica = use_replica if use_replica is not None else self.use_read_replica
        session_ctx = get_read_session() if should_use_replica else get_session()
        
        async with session_ctx as s:
            r = await s.execute(text(f'SELECT COUNT(*) FROM "{self.name}" {where}'), params)
            return r.scalar() or 0
    
    async def insert(self, data: dict) -> Optional[dict]:
        self._check_keys(data, "data column")
        data = self._prep_json(data)
        col_list = ", ".join(f'"{c}"' for c in data)
        placeholders = ", ".join(f":{c}::jsonb" if c in self._json_cols else f":{c}" for c in data)
        async with get_session() as s:
            r = await s.execute(text(f'INSERT INTO "{self.name}" ({col_list}) VALUES ({placeholders}) RETURNING *'), data)
            await s.commit()
            row = r.fetchone()
            return dict(row._mapping) if row else None
    
    async def update(self, id_col: str, id_val, data: dict) -> Optional[dict]:
        id_col = _validate_identifier(id_col, "id column")
        if not data:
            return await self.get(id_col, id_val)
        self._check_keys(data, "data column")
        data = self._prep_json(data)
        set_clause = ", ".join(f'"{k}" = :{k}::jsonb' if k in self._json_cols else f'"{k}" = :{k}' for k in data)
        async with get_session() as s:
            r = await s.execute(text(f'UPDATE "{self.name}" SET {set_clause} WHERE "{id_col}" = :id RETURNING *'), {**data, "id": id_val})
            await s.commit()
            row = r.fetchone()
            return dict(row._mapping) if row else None
    
    async def upsert(self, conflict_col: str, data: dict) -> Optional[dict]:
        conflict_col = _validate_identifier(conflict_col, "conflict column")
        self._check_keys(data, "data column")
        data = self._prep_json(data)
        col_list = ", ".join(f'"{c}"' for c in data)
        placeholders = ", ".join(f":{c}::jsonb" if c in self._json_cols else f":{c}" for c in data)
        update_cols = [c for c in data if c != conflict_col]
        update_clause = ", ".join(f'"{c}" = EXCLUDED."{c}"' for c in update_cols)
        sql = f'INSERT INTO "{self.name}" ({col_list}) VALUES ({placeholders}) ON CONFLICT ("{conflict_col}") DO UPDATE SET {update_clause} RETURNING *'
        async with get_session() as s:
            r = await s.execute(text(sql), data)
            await s.commit()
            row = r.fetchone()
            return dict(row._mapping) if row else None
    
    async def delete(self, id_col: str, id_val) -> bool:
        id_col = _validate_identifier(id_col, "id column")
        async with get_session() as s:
            r = await s.execute(text(f'DELETE FROM "{self.name}" WHERE "{id_col}" = :id RETURNING "{id_col}"'), {"id": id_val})
            await s.commit()
            return r.fetchone() is not None
    
    async def delete_by(self, filters: dict) -> int:
        self._check_keys(filters, "filter column")
        where = " AND ".join(f'"{k}" = :f_{k}' for k in filters)
        params = {f"f_{k}": v for k, v in filters.items()}
        async with get_session() as s:
            r = await s.execute(text(f'DELETE FROM "{self.name}" WHERE {where}'), params)
            await s.commit()
            return r.rowcount


def table(name: str, use_read_replica: bool = True) -> Table:
    """
    Create a Table helper.
    
    Args:
        name: Table name
        use_read_replica: If True, SELECT queries will use read replica when available.
                        Set to False if you need strong consistency (read-after-write).
    """
    return Table(name, use_read_replica=use_read_replica)
