"""Categorization background job dispatch functions."""


async def categorize(project_id: str):
    """Dispatch project categorization task."""
    from core.worker import dispatch_categorization
    await dispatch_categorization(project_id)


async def process_stale():
    """Dispatch stale projects processing task."""
    from core.worker import dispatch_stale_projects
    await dispatch_stale_projects()


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
    lambda project_id: __import__('core.worker', fromlist=['dispatch_categorization']).dispatch_categorization(project_id)
)

process_stale_projects = _DispatchWrapper(
    lambda: __import__('core.worker', fromlist=['dispatch_stale_projects']).dispatch_stale_projects()
)
