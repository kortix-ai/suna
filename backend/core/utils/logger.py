import logging
import os
import socket
import structlog

# Load environment variables from .env file if it exists
try:
    from dotenv import load_dotenv
    from pathlib import Path

    env_file = Path(__file__).parent.parent.parent / ".env"
    if env_file.exists():
        load_dotenv(env_file, override=True)
except ImportError:
    pass  # dotenv not available, use system env vars only

ENV_MODE = os.getenv("ENV_MODE", "LOCAL").upper()

# Set default logging level based on environment
# Production should be INFO (less verbose), local/staging can be DEBUG
default_level = "INFO" if ENV_MODE == "PRODUCTION" else "DEBUG"
LOGGING_LEVEL = logging.getLevelNamesMapping().get(
    os.getenv("LOGGING_LEVEL", default_level).upper(),
    logging.INFO,
)

# Set root logger level (but don't add default handler - we'll add our own)
logging.getLogger().setLevel(LOGGING_LEVEL)
# Clear any existing handlers to avoid duplicate output
logging.getLogger().handlers.clear()

# Keep third-party library noise down (only warnings+)
NOISY_LOGGERS = (
    # AWS SDK
    "boto3", "botocore", "urllib3", "s3transfer", "watchtower",
    # HTTP clients
    "httpcore", "httpx", "aiohttp", "requests", "hpack",
    # Async / event loop
    "asyncio", "concurrent",
    # AI SDKs
    "openai", "anthropic", "httpx._client",
    # Web frameworks
    "uvicorn.access", "uvicorn.error", "fastapi",
    # Database
    "sqlalchemy", "databases", "aiosqlite",
    # Other
    "websockets", "multipart", "charset_normalizer",
)
for noisy_logger in NOISY_LOGGERS:
    logging.getLogger(noisy_logger).setLevel(logging.WARNING)

# Optional: separate CloudWatch handler level (defaults to INFO)
CLOUDWATCH_LOG_LEVEL = logging.getLevelNamesMapping().get(
    os.getenv("CLOUDWATCH_LOG_LEVEL", "INFO").upper(),
    LOGGING_LEVEL,
)

# Common pre-chain used by both console and CloudWatch formatters
# Simplified: only func_name for cleaner output (filename:lineno adds clutter)
foreign_pre_chain = [
    structlog.stdlib.add_log_level,
    structlog.stdlib.PositionalArgumentsFormatter(),
    structlog.processors.TimeStamper(fmt="iso"),
    structlog.processors.CallsiteParameterAdder(
        {
            structlog.processors.CallsiteParameter.FILENAME,
            structlog.processors.CallsiteParameter.FUNC_NAME,
            structlog.processors.CallsiteParameter.LINENO,
        }
    ),
    structlog.contextvars.merge_contextvars,
]

# Renderer selection per environment
if ENV_MODE in ("LOCAL", "STAGING"):
    console_renderer = structlog.dev.ConsoleRenderer(colors=True)
else:
    console_renderer = structlog.processors.JSONRenderer()

# Configure structlog to emit into stdlib logging
structlog.configure(
    processors=[
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.CallsiteParameterAdder(
            {
                structlog.processors.CallsiteParameter.FILENAME,
                structlog.processors.CallsiteParameter.FUNC_NAME,
                structlog.processors.CallsiteParameter.LINENO,
            }
        ),
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
    ],
    logger_factory=structlog.stdlib.LoggerFactory(),
    wrapper_class=structlog.stdlib.BoundLogger,
    cache_logger_on_first_use=True,
)

# Console handler (stdout)
console_handler = logging.StreamHandler()
console_handler.setLevel(LOGGING_LEVEL)
console_handler.setFormatter(
    structlog.stdlib.ProcessorFormatter(
        processor=console_renderer,
        foreign_pre_chain=foreign_pre_chain,
    )
)
logging.getLogger().addHandler(console_handler)


def _setup_cloudwatch_logging() -> None:
    """Attach a CloudWatch handler when enabled and available."""
    if ENV_MODE not in ("PRODUCTION", "STAGING"):
        return

    default_enabled = "true" if ENV_MODE == "PRODUCTION" else "false"
    cloudwatch_enabled = (
        os.getenv("CLOUDWATCH_LOGGING_ENABLED", default_enabled).lower() == "true"
    )
    if not cloudwatch_enabled:
        return

    try:
        import watchtower
        import boto3

        default_log_group = (
            "/kortix/production" if ENV_MODE == "PRODUCTION" else "/kortix/staging"
        )
        log_group_name = os.getenv("CLOUDWATCH_LOG_GROUP", default_log_group)
        aws_region = os.getenv("AWS_DEFAULT_REGION", os.getenv("AWS_REGION", "us-west-2"))

        log_stream_name = os.getenv("CLOUDWATCH_LOG_STREAM")
        if not log_stream_name:
            log_stream_name = f"api/{socket.gethostname()}"

        aws_access_key_id = os.getenv("AWS_ACCESS_KEY_ID")
        aws_secret_access_key = os.getenv("AWS_SECRET_ACCESS_KEY")

        if aws_access_key_id and aws_secret_access_key:
            logs_client = boto3.client(
                "logs",
                region_name=aws_region,
                aws_access_key_id=aws_access_key_id,
                aws_secret_access_key=aws_secret_access_key,
            )
        else:
            logs_client = boto3.client("logs", region_name=aws_region)

        # Best-effort: ensure log group exists
        try:
            logs_client.create_log_group(logGroupName=log_group_name)
        except logs_client.exceptions.ResourceAlreadyExistsException:
            pass
        except Exception as group_error:
            logging.getLogger().warning(
                f"Could not create CloudWatch log group '{log_group_name}': {group_error}"
            )

        cloudwatch_handler = watchtower.CloudWatchLogHandler(
            log_group=log_group_name,
            stream_name=log_stream_name,
            use_queues=True,
            send_interval=5,
            max_batch_size=100,
            max_batch_count=1000,
            boto3_client=logs_client,
        )
        cloudwatch_handler.setLevel(CLOUDWATCH_LOG_LEVEL)
        cloudwatch_handler.setFormatter(
            structlog.stdlib.ProcessorFormatter(
                processor=structlog.processors.JSONRenderer(),
                foreign_pre_chain=foreign_pre_chain,
            )
        )
        logging.getLogger().addHandler(cloudwatch_handler)
        logging.getLogger().info(
            f"CloudWatch logging enabled: group={log_group_name}, stream={log_stream_name}"
        )
    except ImportError:
        logging.getLogger().warning(
            "watchtower not installed. CloudWatch logging disabled. Install with: uv add watchtower"
        )
    except Exception as e:
        logging.getLogger().warning(
            f"Failed to setup CloudWatch logging: {e}. Falling back to stdout only."
        )


_setup_cloudwatch_logging()

logger: structlog.stdlib.BoundLogger = structlog.get_logger()
