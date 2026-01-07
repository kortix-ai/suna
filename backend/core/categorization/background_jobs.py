"""Categorization background job dispatch functions."""


async def categorize(project_id: str):
    """Start project categorization task."""
    from core.worker.background_tasks import start_categorization
    start_categorization(project_id)


async def process_stale():
    """Start stale projects processing task."""
    from core.worker.background_tasks import start_stale_projects
    start_stale_projects()


# Backwards-compatible wrappers with .send() interface
class _DispatchWrapper:
    def __init__(self, dispatch_fn):
        self._dispatch_fn = dispatch_fn
    
    def send(self, *args, **kwargs):
        import asyncio
        try:
            loop = asyncio.get_running_loop()
            asyncio.create_task(self._dispatch_fn(*args, **kwargs))
        except RuntimeError:
            asyncio.run(self._dispatch_fn(*args, **kwargs))
    
    def send_with_options(self, args=None, kwargs=None, delay=None):
        args = args or ()
        kwargs = kwargs or {}
        self.send(*args, **kwargs)


categorize_project = _DispatchWrapper(
    lambda project_id: __import__('core.worker.background_tasks', fromlist=['start_categorization']).start_categorization(project_id)
)

process_stale_projects = _DispatchWrapper(
    lambda: __import__('core.worker.background_tasks', fromlist=['start_stale_projects']).start_stale_projects()
)
