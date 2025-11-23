import novu_py
from novu_py import Novu

print("TriggerEventRequestDto annotations:")
try:
    print(novu_py.TriggerEventRequestDto.__annotations__)
except AttributeError:
    print("No annotations found")

print("\nSubscriberPayloadDto annotations:")
try:
    print(novu_py.SubscriberPayloadDto.__annotations__)
except AttributeError:
    print("No annotations found")

# Check if there's a Union for 'to'
import typing
try:
    print("\nChecking 'to' field type in TriggerEventRequestDto:")
    if hasattr(novu_py.TriggerEventRequestDto, '__annotations__'):
        print(novu_py.TriggerEventRequestDto.__annotations__.get('to'))
except Exception as e:
    print(e)

