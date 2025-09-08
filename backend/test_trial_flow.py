#!/usr/bin/env python3
"""
Test the complete trial flow
Run with: python test_trial_flow.py
"""
import os
import asyncio
from supabase import create_client, Client
import random
import string
import requests

def generate_test_email():
    random_str = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"test_{random_str}@example.com"

async def test_trial_flow():
    print("=" * 60)
    print("TESTING COMPLETE TRIAL FLOW")
    print("=" * 60)
    
    supabase_url = os.getenv('SUPABASE_URL')
    supabase_key = os.getenv('SUPABASE_ANON_KEY')
    service_key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
    backend_url = os.getenv('BACKEND_URL', 'http://localhost:8000')
    
    if not all([supabase_url, supabase_key, service_key]):
        print("❌ Missing required environment variables")
        return
    
    supabase: Client = create_client(supabase_url, supabase_key)
    service_client: Client = create_client(supabase_url, service_key)
    
    test_email = generate_test_email()
    test_password = "TestPassword123!"
    
    print(f"\n1. SIGNING UP NEW USER:")
    print(f"   Email: {test_email}")
    
    try:
        # Sign up
        response = supabase.auth.sign_up({
            "email": test_email,
            "password": test_password,
        })
        
        if response.user:
            print(f"   ✅ Signup successful!")
            user_id = response.user.id
            
            # Sign in to get session
            sign_in_response = supabase.auth.sign_in_with_password({
                "email": test_email,
                "password": test_password,
            })
            
            if sign_in_response.session:
                print(f"   ✅ Sign-in successful!")
                access_token = sign_in_response.session.access_token
                
                print(f"\n2. CHECKING INITIAL CREDIT ACCOUNT:")
                result = service_client.table('credit_accounts').select('*').eq('account_id', user_id).execute()
                
                if result.data and len(result.data) > 0:
                    account = result.data[0]
                    print(f"   ✅ Credit account exists!")
                    print(f"   - Tier: {account.get('tier')}")
                    print(f"   - Balance: ${account.get('balance')}")
                    print(f"   - Trial Status: {account.get('trial_status')}")
                else:
                    print(f"   ⚠️  No credit account yet")
                
                print(f"\n3. CALLING TRIAL START ENDPOINT:")
                trial_response = requests.post(
                    f"{backend_url}/billing/v2/trial/start",
                    headers={
                        "Authorization": f"Bearer {access_token}",
                        "Content-Type": "application/json"
                    }
                )
                
                if trial_response.status_code == 200:
                    trial_data = trial_response.json()
                    print(f"   ✅ Trial endpoint called successfully!")
                    print(f"   Response: {trial_data}")
                    
                    if trial_data.get('trial_started'):
                        print(f"   ✅ Trial started!")
                        print(f"   - Credits: ${trial_data.get('credits_granted')}")
                        print(f"   - Tier: {trial_data.get('tier')}")
                        print(f"   - Ends at: {trial_data.get('trial_ends_at')}")
                    elif trial_data.get('requires_checkout'):
                        print(f"   ⚠️  Payment method required")
                        print(f"   - Message: {trial_data.get('message')}")
                else:
                    print(f"   ❌ Trial endpoint failed: {trial_response.status_code}")
                    print(f"   Error: {trial_response.text}")
                
                print(f"\n4. CHECKING FINAL CREDIT ACCOUNT:")
                result = service_client.table('credit_accounts').select('*').eq('account_id', user_id).execute()
                
                if result.data and len(result.data) > 0:
                    account = result.data[0]
                    print(f"   ✅ Credit account updated!")
                    print(f"   - Tier: {account.get('tier')}")
                    print(f"   - Balance: ${account.get('balance')}")
                    print(f"   - Trial Status: {account.get('trial_status')}")
                    print(f"   - Trial Ends: {account.get('trial_ends_at')}")
                
                print(f"\n5. CHECKING TRIAL HISTORY:")
                result = service_client.table('trial_history').select('*').eq('account_id', user_id).execute()
                
                if result.data and len(result.data) > 0:
                    history = result.data[0]
                    print(f"   ✅ Trial history recorded!")
                    print(f"   - Mode: {history.get('trial_mode')}")
                    print(f"   - Credits Granted: ${history.get('credits_granted')}")
                    print(f"   - Started: {history.get('started_at')}")
                
                print(f"\n6. CLEANUP:")
                try:
                    service_client.auth.admin.delete_user(user_id)
                    print(f"   ✅ Deleted test user")
                except Exception as e:
                    print(f"   ⚠️  Could not delete user: {e}")
            else:
                print(f"   ❌ Sign-in failed")
        else:
            print(f"   ❌ Signup failed")
            
    except Exception as e:
        print(f"   ❌ Error: {e}")
        import traceback
        traceback.print_exc()
    
    print("\n" + "=" * 60)
    print("TEST COMPLETE")
    print("=" * 60)

if __name__ == "__main__":
    asyncio.run(test_trial_flow()) 