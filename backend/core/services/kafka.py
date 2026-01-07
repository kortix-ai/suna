import os
import json
import uuid
import time
import asyncio
import threading
from typing import Optional, Any, Dict, List
from dataclasses import dataclass, field, asdict
from enum import Enum
from datetime import datetime, timezone

from core.utils.logger import logger

KAFKA_ENABLED = os.getenv("KAFKA_ENABLED", "false").lower() == "true"
KAFKA_BOOTSTRAP_SERVERS = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
KAFKA_TOPIC_WRITES = os.getenv("KAFKA_TOPIC_WRITES", "supabase.writes")
KAFKA_SASL_USERNAME = os.getenv("KAFKA_SASL_USERNAME", "")
KAFKA_SASL_PASSWORD = os.getenv("KAFKA_SASL_PASSWORD", "")

TABLES_TO_BUFFER = {"messages", "credit_ledger"}

KAFKA_CONSUMER_GROUP = "db-writer"
KAFKA_BATCH_SIZE = 100
KAFKA_BATCH_TIMEOUT_SEC = 0.1


def get_kafka_config() -> Dict[str, str]:
    conf = {
        'bootstrap.servers': KAFKA_BOOTSTRAP_SERVERS,
        'client.id': f'suna-producer-{os.getpid()}',
    }
    if KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD:
        conf.update({
            'security.protocol': 'SASL_SSL',
            'sasl.mechanisms': 'PLAIN',
            'sasl.username': KAFKA_SASL_USERNAME,
            'sasl.password': KAFKA_SASL_PASSWORD,
        })
    return conf


def is_enabled() -> bool:
    return KAFKA_ENABLED


class WriteOperation(Enum):
    INSERT = "insert"
    UPDATE = "update"
    UPSERT = "upsert"
    DELETE = "delete"


@dataclass
class BufferedWrite:
    event_id: str
    table: str
    operation: str
    data: Any
    filters: Optional[Dict[str, Any]] = None
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    
    def to_json(self) -> bytes:
        return json.dumps(asdict(self)).encode('utf-8')
    
    @classmethod
    def from_json(cls, data: bytes) -> 'BufferedWrite':
        d = json.loads(data.decode('utf-8'))
        return cls(**d)


class KafkaProducerManager:
    _producer = None
    _lock = threading.Lock()
    _initialized = False
    
    @classmethod
    def get_producer(cls):
        if not KAFKA_ENABLED:
            return None
        
        if cls._producer is None and not cls._initialized:
            with cls._lock:
                if cls._producer is None and not cls._initialized:
                    cls._initialized = True
                    try:
                        from confluent_kafka import Producer
                        conf = get_kafka_config()
                        conf['linger.ms'] = 50
                        conf['batch.size'] = 65536
                        conf['compression.type'] = 'lz4'
                        conf['acks'] = '1'
                        cls._producer = Producer(conf)
                        logger.info(f"🚀 Kafka producer connected: {KAFKA_BOOTSTRAP_SERVERS}")
                    except ImportError:
                        logger.warning("⚠️ confluent-kafka not installed, Kafka buffering disabled")
                    except Exception as e:
                        logger.error(f"❌ Kafka producer failed to initialize: {e}")
        return cls._producer
    
    @classmethod
    def flush(cls, timeout: float = 5.0):
        if cls._producer:
            cls._producer.flush(timeout)
    
    @classmethod
    def poll(cls, timeout: float = 0):
        if cls._producer:
            cls._producer.poll(timeout)
    
    @classmethod
    def stop(cls):
        with cls._lock:
            if cls._producer:
                try:
                    cls._producer.flush(10.0)
                except Exception as e:
                    logger.warning(f"Error flushing Kafka producer: {e}")
                cls._producer = None
                cls._initialized = False
                logger.info("Kafka producer stopped")


async def send_to_kafka(event: BufferedWrite) -> bool:
    producer = KafkaProducerManager.get_producer()
    if producer is None:
        return False
    
    try:
        def _send():
            producer.produce(
                KAFKA_TOPIC_WRITES,
                value=event.to_json(),
                key=event.table.encode('utf-8'),
            )
            producer.poll(0)
        
        await asyncio.get_event_loop().run_in_executor(None, _send)
        logger.debug(f"📤 Kafka: buffered {event.operation} to {event.table}")
        return True
    except Exception as e:
        logger.warning(f"⚠️ Kafka send failed: {e}")
        return False


def should_buffer_table(table: str) -> bool:
    return KAFKA_ENABLED and table in TABLES_TO_BUFFER

_consumer_running = True

def stop_consumer():
    global _consumer_running
    _consumer_running = False


async def _process_batch(db_client, events_by_table: Dict[str, List[BufferedWrite]], stats: Dict[str, int]):
    """Process a batch of buffered writes. Only INSERTs are buffered through Kafka."""
    for table, events in events_by_table.items():
        # Only inserts are buffered (updates/upserts/deletes go directly to DB)
        inserts = [e for e in events if e.operation == WriteOperation.INSERT.value]
        
        if not inserts:
            continue
        
        try:
            flat_data = []
            for e in inserts:
                if isinstance(e.data, list):
                    flat_data.extend(e.data)
                else:
                    flat_data.append(e.data)
            
            await db_client.table(table).insert(flat_data).execute()
            stats['processed'] += len(inserts)
            logger.debug(f"📝 Flushed {len(inserts)} inserts to {table}")
                
        except Exception as e:
            logger.error(f"❌ Batch insert failed for {table}: {e}")
            stats['errors'] += 1


def run_consumer():
    global _consumer_running
    _consumer_running = True
    
    if not KAFKA_ENABLED:
        logger.warning("KAFKA_ENABLED is not set to true, consumer not starting")
        return
    
    try:
        from confluent_kafka import Consumer
    except ImportError:
        logger.error("confluent-kafka not installed: pip install confluent-kafka")
        return
    
    conf = get_kafka_config()
    conf['group.id'] = KAFKA_CONSUMER_GROUP
    conf['auto.offset.reset'] = 'earliest'
    conf['enable.auto.commit'] = False
    conf['session.timeout.ms'] = 45000
    
    consumer = Consumer(conf)
    consumer.subscribe([KAFKA_TOPIC_WRITES])
    
    logger.info(f"🚀 Kafka consumer started: {KAFKA_TOPIC_WRITES} @ {KAFKA_BOOTSTRAP_SERVERS}")
    
    stats = {'processed': 0, 'batches': 0, 'errors': 0}
    
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    
    from core.services.supabase import DBConnection
    db = DBConnection.create_fresh()
    loop.run_until_complete(db.initialize())
    
    try:
        batch: List[BufferedWrite] = []
        batch_start = time.time()
        
        while _consumer_running:
            msg = consumer.poll(0.05)
            
            if msg is not None:
                if msg.error():
                    logger.error(f"Consumer error: {msg.error()}")
                    stats['errors'] += 1
                else:
                    try:
                        event = BufferedWrite.from_json(msg.value())
                        batch.append(event)
                    except Exception as e:
                        logger.error(f"Failed to parse event: {e}")
                        stats['errors'] += 1
            
            should_flush = (
                len(batch) >= KAFKA_BATCH_SIZE or
                (batch and time.time() - batch_start >= KAFKA_BATCH_TIMEOUT_SEC)
            )
            
            if should_flush and batch:
                events_by_table: Dict[str, List[BufferedWrite]] = {}
                for event in batch:
                    if event.table not in events_by_table:
                        events_by_table[event.table] = []
                    events_by_table[event.table].append(event)
                
                raw_client = loop.run_until_complete(db.raw_client)
                loop.run_until_complete(_process_batch(raw_client, events_by_table, stats))
                consumer.commit()
                
                stats['batches'] += 1
                total = len(batch)
                if total > 0:
                    logger.debug(f"📝 Flushed {total} writes | total: {stats['processed']} | errors: {stats['errors']}")
                
                batch = []
                batch_start = time.time()
    
    except KeyboardInterrupt:
        pass
    finally:
        if batch:
            events_by_table = {}
            for event in batch:
                if event.table not in events_by_table:
                    events_by_table[event.table] = []
                events_by_table[event.table].append(event)
            raw_client = loop.run_until_complete(db.raw_client)
            loop.run_until_complete(_process_batch(raw_client, events_by_table, stats))
            consumer.commit()
        
        consumer.close()
        loop.close()
        logger.info(f"Kafka consumer stopped. Stats: {stats}")


__all__ = [
    'KAFKA_ENABLED',
    'KAFKA_BOOTSTRAP_SERVERS',
    'KAFKA_TOPIC_WRITES',
    'TABLES_TO_BUFFER',
    'is_enabled',
    'get_kafka_config',
    'WriteOperation',
    'BufferedWrite',
    'KafkaProducerManager',
    'send_to_kafka',
    'should_buffer_table',
    'stop_consumer',
    'run_consumer',
]
