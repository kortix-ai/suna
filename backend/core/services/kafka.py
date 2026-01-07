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

KAFKA_ENABLED = False
KAFKA_BOOTSTRAP_SERVERS = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
KAFKA_TOPIC_WRITES = os.getenv("KAFKA_TOPIC_WRITES", "supabase.writes")
KAFKA_SASL_USERNAME = os.getenv("KAFKA_SASL_USERNAME", "")
KAFKA_SASL_PASSWORD = os.getenv("KAFKA_SASL_PASSWORD", "")

TABLES_TO_BUFFER = {"messages", "credit_ledger"}

KAFKA_CONSUMER_GROUP = os.getenv("KAFKA_CONSUMER_GROUP", "supabase-writer")
KAFKA_BATCH_SIZE = int(os.getenv("KAFKA_BATCH_SIZE", "100"))
KAFKA_BATCH_TIMEOUT_SEC = float(os.getenv("KAFKA_BATCH_TIMEOUT_SEC", "0.5"))
KAFKA_DLQ_TOPIC = os.getenv("KAFKA_DLQ_TOPIC", "supabase.writes.dlq")
KAFKA_MAX_RETRIES = int(os.getenv("KAFKA_MAX_RETRIES", "3"))

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


def _get_partition_key(event: BufferedWrite) -> bytes:
    if event.data and isinstance(event.data, dict):
        if event.table == "messages" and "thread_id" in event.data:
            return event.data["thread_id"].encode('utf-8')
        if event.table == "credit_ledger" and "account_id" in event.data:
            return event.data["account_id"].encode('utf-8')
    return event.table.encode('utf-8')


async def send_to_kafka(event: BufferedWrite) -> bool:
    producer = KafkaProducerManager.get_producer()
    if producer is None:
        return False
    
    try:
        partition_key = _get_partition_key(event)
        
        def _send():
            producer.produce(
                KAFKA_TOPIC_WRITES,
                value=event.to_json(),
                key=partition_key,
            )
            producer.poll(0)
        
        await asyncio.get_event_loop().run_in_executor(None, _send)
        logger.debug(f"📤 Kafka: buffered {event.operation} to {event.table}")
        return True
    except Exception as e:
        logger.warning(f"⚠️ Kafka send failed: {e}")
        return False


async def send_to_dlq(producer, event: BufferedWrite, error: str):
    try:
        dlq_event = {
            **asdict(event),
            'error': error,
            'failed_at': datetime.now(timezone.utc).isoformat(),
        }
        producer.produce(
            KAFKA_DLQ_TOPIC,
            value=json.dumps(dlq_event).encode('utf-8'),
            key=event.table.encode('utf-8'),
        )
        producer.poll(0)
        logger.warning(f"📥 Sent failed event to DLQ: {event.table}/{event.event_id}")
    except Exception as e:
        logger.error(f"❌ Failed to send to DLQ: {e}")


def should_buffer_table(table: str) -> bool:
    return KAFKA_ENABLED and table in TABLES_TO_BUFFER

_consumer_running = True

def stop_consumer():
    global _consumer_running
    _consumer_running = False


async def _process_batch(
    db_client, 
    events_by_table: Dict[str, List[BufferedWrite]], 
    stats: Dict[str, int],
    dlq_producer=None,
):
    for table, events in events_by_table.items():
        inserts = [e for e in events if e.operation == WriteOperation.INSERT.value]
        
        if not inserts:
            continue
        
        flat_data = []
        for e in inserts:
            if isinstance(e.data, list):
                flat_data.extend(e.data)
            else:
                flat_data.append(e.data)
        
        last_error = None
        for attempt in range(KAFKA_MAX_RETRIES):
            try:
                await db_client.table(table).insert(flat_data).execute()
                stats['processed'] += len(inserts)
                logger.debug(f"📝 Flushed {len(inserts)} inserts to {table}")
                break
            except Exception as e:
                last_error = e
                if attempt < KAFKA_MAX_RETRIES - 1:
                    delay = 0.1 * (2 ** attempt)
                    logger.warning(f"⚠️ Batch insert retry {attempt + 1}/{KAFKA_MAX_RETRIES} for {table}: {e}")
                    await asyncio.sleep(delay)
        else:
            logger.error(f"❌ Batch insert failed for {table} after {KAFKA_MAX_RETRIES} retries: {last_error}")
            stats['errors'] += len(inserts)
            
            if dlq_producer:
                for event in inserts:
                    await send_to_dlq(dlq_producer, event, str(last_error))


def run_consumer():
    global _consumer_running
    _consumer_running = True
    
    if not KAFKA_ENABLED:
        logger.warning("KAFKA_ENABLED is not set to true, consumer not starting")
        return
    
    try:
        from confluent_kafka import Consumer, Producer
    except ImportError:
        logger.error("confluent-kafka not installed: pip install confluent-kafka")
        return
    
    conf = get_kafka_config()
    conf['group.id'] = KAFKA_CONSUMER_GROUP
    conf['auto.offset.reset'] = 'earliest'
    conf['enable.auto.commit'] = False
    conf['session.timeout.ms'] = 45000
    conf['max.poll.interval.ms'] = 300000
    
    consumer = Consumer(conf)
    consumer.subscribe([KAFKA_TOPIC_WRITES])
    
    dlq_producer = Producer(get_kafka_config())
    
    logger.info(f"🚀 Kafka consumer started: {KAFKA_TOPIC_WRITES} @ {KAFKA_BOOTSTRAP_SERVERS}")
    logger.info(f"   DLQ topic: {KAFKA_DLQ_TOPIC} | batch_size={KAFKA_BATCH_SIZE} | timeout={KAFKA_BATCH_TIMEOUT_SEC}s")
    
    stats = {'processed': 0, 'batches': 0, 'errors': 0, 'dlq': 0}
    
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    
    from core.services.supabase import DBConnection
    db = DBConnection.create_fresh()
    loop.run_until_complete(db.initialize())
    
    try:
        batch: List[BufferedWrite] = []
        batch_start = time.time()
        last_stats_log = time.time()
        
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
                loop.run_until_complete(_process_batch(raw_client, events_by_table, stats, dlq_producer))
                consumer.commit()
                dlq_producer.poll(0)
                
                stats['batches'] += 1
                batch = []
                batch_start = time.time()
            
            if time.time() - last_stats_log >= 60:
                logger.info(f"📊 Kafka consumer stats: processed={stats['processed']} batches={stats['batches']} errors={stats['errors']}")
                last_stats_log = time.time()
    
    except KeyboardInterrupt:
        logger.info("Kafka consumer interrupted")
    finally:
        if batch:
            events_by_table = {}
            for event in batch:
                if event.table not in events_by_table:
                    events_by_table[event.table] = []
                events_by_table[event.table].append(event)
            raw_client = loop.run_until_complete(db.raw_client)
            loop.run_until_complete(_process_batch(raw_client, events_by_table, stats, dlq_producer))
            consumer.commit()
        
        dlq_producer.flush(10.0)
        consumer.close()
        loop.close()
        logger.info(f"✅ Kafka consumer stopped. Final stats: {stats}")


__all__ = [
    'KAFKA_ENABLED',
    'KAFKA_BOOTSTRAP_SERVERS',
    'KAFKA_TOPIC_WRITES',
    'KAFKA_DLQ_TOPIC',
    'TABLES_TO_BUFFER',
    'is_enabled',
    'get_kafka_config',
    'WriteOperation',
    'BufferedWrite',
    'KafkaProducerManager',
    'send_to_kafka',
    'send_to_dlq',
    'should_buffer_table',
    'stop_consumer',
    'run_consumer',
]
