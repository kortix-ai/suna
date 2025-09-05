#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent.parent))

import stripe
import json
from core.utils.config import config

async def debug_stripe():
    stripe.api_key = config.STRIPE_SECRET_KEY
    
    print("\n" + "="*60)
    print("DEBUGGING STRIPE SUBSCRIPTION STRUCTURE")
    print("="*60)
    
    # Get one subscription to inspect its structure
    try:
        # First, list all subscriptions
        all_subs = await stripe.Subscription.list_async(limit=5)
        
        if not all_subs.data:
            print("No subscriptions found")
            return
        
        # Take the first subscription for detailed analysis
        sub_id = all_subs.data[0].id
        print(f"\nAnalyzing subscription: {sub_id}")
        print("-" * 40)
        
        # Fetch with different expansion levels
        print("\n1. WITHOUT EXPANSION:")
        sub = await stripe.Subscription.retrieve_async(sub_id)
        
        # Check structure
        print(f"  Type: {type(sub)}")
        print(f"  Has 'items': {hasattr(sub, 'items')}")
        if hasattr(sub, 'items'):
            print(f"  Items type: {type(sub.items)}")
            print(f"  Has 'data': {hasattr(sub.items, 'data')}")
            if hasattr(sub.items, 'data'):
                print(f"  Items.data type: {type(sub.items.data)}")
                print(f"  Items.data length: {len(sub.items.data)}")
                if len(sub.items.data) > 0:
                    item = sub.items.data[0]
                    print(f"  First item type: {type(item)}")
                    print(f"  Has 'price': {hasattr(item, 'price')}")
                    if hasattr(item, 'price'):
                        print(f"  Price type: {type(item.price)}")
                        # Try to access as dict
                        if isinstance(item.price, dict):
                            print(f"  Price is dict with keys: {item.price.keys()}")
                            print(f"  Price ID: {item.price.get('id', 'NOT FOUND')}")
                        # Try to access as object
                        elif hasattr(item.price, 'id'):
                            print(f"  Price has 'id': {item.price.id}")
                        else:
                            # Print the actual price value
                            print(f"  Price value: {item.price}")
        
        print("\n2. WITH ITEMS EXPANSION:")
        sub_expanded = await stripe.Subscription.retrieve_async(
            sub_id,
            expand=['items']
        )
        
        if hasattr(sub_expanded, 'items') and hasattr(sub_expanded.items, 'data'):
            if len(sub_expanded.items.data) > 0:
                item = sub_expanded.items.data[0]
                print(f"  First item type: {type(item)}")
                if hasattr(item, 'price'):
                    print(f"  Price type: {type(item.price)}")
                    # Check different ways to access
                    if isinstance(item.price, str):
                        print(f"  Price is string: {item.price}")
                    elif isinstance(item.price, dict):
                        print(f"  Price is dict: {json.dumps(item.price, indent=2, default=str)}")
                    else:
                        print(f"  Price object attributes: {dir(item.price)}")
        
        print("\n3. WITH PRICE EXPANSION:")
        sub_price_expanded = await stripe.Subscription.retrieve_async(
            sub_id,
            expand=['items.data.price']
        )
        
        if hasattr(sub_price_expanded, 'items') and hasattr(sub_price_expanded.items, 'data'):
            if len(sub_price_expanded.items.data) > 0:
                item = sub_price_expanded.items.data[0]
                print(f"  First item type: {type(item)}")
                if hasattr(item, 'price'):
                    price = item.price
                    print(f"  Price type: {type(price)}")
                    
                    # Try different access methods
                    if hasattr(price, 'id'):
                        print(f"  Price.id (attr): {price.id}")
                    
                    if hasattr(price, '__getitem__'):
                        try:
                            print(f"  Price['id'] (dict): {price['id']}")
                        except:
                            pass
                    
                    # Print all available attributes
                    attrs = [a for a in dir(price) if not a.startswith('_')]
                    print(f"  Available price attributes: {attrs[:10]}...")  # First 10
                    
                    # Try to convert to dict
                    try:
                        if hasattr(price, 'to_dict'):
                            price_dict = price.to_dict()
                            print(f"  Price as dict: {json.dumps(price_dict, indent=2, default=str)[:500]}...")
                    except:
                        pass
        
        print("\n" + "="*60)
        print("RAW API CALL")
        print("="*60)
        
        # Make a raw API call to see what we actually get
        import aiohttp
        async with aiohttp.ClientSession() as session:
            url = f"https://api.stripe.com/v1/subscriptions/{sub_id}"
            headers = {
                "Authorization": f"Bearer {stripe.api_key}",
            }
            async with session.get(url, headers=headers) as response:
                data = await response.json()
                if 'items' in data and 'data' in data['items']:
                    if len(data['items']['data']) > 0:
                        item = data['items']['data'][0]
                        print(f"Raw item keys: {item.keys()}")
                        if 'price' in item:
                            print(f"Raw price: {item['price']}")
                            
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(debug_stripe()) 