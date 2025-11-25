import novu_py
from typing import get_args, get_origin

To = novu_py.To
print(f"To type: {To}")
print(f"To origin: {get_origin(To)}")
print(f"To args: {get_args(To)}")

# Also check SubscriberPayloadDto vs SubscriberDto
print("\nSubscriberDto annotations:")
if hasattr(novu_py, 'SubscriberDto'):
     print(novu_py.SubscriberDto.__annotations__)

