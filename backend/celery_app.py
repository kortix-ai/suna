from celery import Celery
from utils.config import config # Assuming REDIS_URL is in this config object
import os

# It's good practice to ensure the REDIS_URL is set
redis_url = os.getenv('REDIS_URL', getattr(config, 'REDIS_URL', 'redis://localhost:6379/0'))

celery_app = Celery(
    'suna_tasks', # Name of the celery application
    broker=redis_url,
    backend=redis_url,
    include=['agent.tasks'] # List of modules to import when the worker starts
)

celery_app.conf.update(
    task_serializer='json',
    accept_content=['json'],
    result_serializer='json',
    timezone='UTC',
    enable_utc=True,
    broker_connection_retry_on_startup=True, # Recommended for robustness
    # Optional: Configure task result expiration (e.g., 1 day)
    # result_expires=86400, 
)

# Optional: If you have specific Celery configurations based on your app's setup,
# you can add them here. For example, for Django integration (not applicable here)
# celery_app.autodiscover_tasks()

if __name__ == '__main__':
    # This allows running Celery worker directly using: python -m backend.celery_app worker -l info
    # However, usually you'll run it using 'celery -A backend.celery_app worker ...'
    celery_app.start() 