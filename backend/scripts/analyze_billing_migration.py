#!/usr/bin/env python3
"""
Analyze existing users before billing cycle migration to identify risks and edge cases.
Run this BEFORE applying the migration to production.

Usage:
    python scripts/analyze_billing_migration.py
    python scripts/analyze_billing_migration.py --export migration_report.json
"""

import asyncio
import argparse
import json
from datetime import datetime, timezone, timedelta
from decimal import Decimal
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.services.supabase import DBConnection
from core.utils.logger import logger

class BillingMigrationAnalyzer:
    def __init__(self):
        self.db = DBConnection()
        self.report = {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'summary': {},
            'risk_users': [],
            'recommendations': []
        }
    
    async def initialize(self):
        await self.db.initialize()
        self.client = await self.db.client
    
    async def analyze_existing_users(self):
        subscriptions = await self.client.schema('basejump').from_('billing_subscriptions')\
            .select('account_id, id, status, created, price_id')\
            .in_('status', ['active', 'trialing'])\
            .execute()
        
        credit_accounts = await self.client.from_('credit_accounts')\
            .select('user_id, balance, tier, last_grant_date, created_at')\
            .execute()
        
        credit_by_user = {ca['user_id']: ca for ca in credit_accounts.data or []}
        
        total_users = len(subscriptions.data or [])
        risk_users = []
        users_by_category = {
            'recently_granted': [],
            'never_granted': [],
            'overdue_grant': [],
            'normal': []
        }
        
        now = datetime.now(timezone.utc)
        
        for sub in subscriptions.data or []:
            user_id = sub['account_id']
            credit_account = credit_by_user.get(user_id, {})
            
            if not credit_account:
                logger.warning(f"User {user_id} has subscription but no credit account!")
                risk_users.append({
                    'user_id': user_id,
                    'risk': 'NO_CREDIT_ACCOUNT',
                    'subscription_created': sub['created']
                })
                continue
            
            last_grant = credit_account.get('last_grant_date')
            subscription_created = datetime.fromisoformat(sub['created'].replace('Z', '+00:00'))
            subscription_day = subscription_created.day
            
            user_info = {
                'user_id': user_id,
                'tier': credit_account.get('tier', 'unknown'),
                'balance': float(credit_account.get('balance', 0)),
                'subscription_day': subscription_day,
                'subscription_created': sub['created'],
                'last_grant_date': last_grant
            }
            
            if last_grant:
                last_grant_date = datetime.fromisoformat(last_grant.replace('Z', '+00:00'))
                days_since_grant = (now - last_grant_date).days
                user_info['days_since_grant'] = days_since_grant
                
                if days_since_grant < 25:
                    users_by_category['recently_granted'].append(user_info)
                    
                    if last_grant_date.day <= 5:
                        risk_users.append({
                            **user_info,
                            'risk': 'RECENT_MONTH_BOUNDARY_GRANT',
                            'details': f'Got credits {days_since_grant} days ago on the {last_grant_date.day}st/nd/rd/th'
                        })
                
                elif days_since_grant > 35:
                    users_by_category['overdue_grant'].append(user_info)
                    risk_users.append({
                        **user_info,
                        'risk': 'OVERDUE_CREDITS',
                        'details': f'Last credits {days_since_grant} days ago'
                    })
                else:
                    users_by_category['normal'].append(user_info)
            else:
                users_by_category['never_granted'].append(user_info)
                days_since_subscription = (now - subscription_created).days
                if days_since_subscription > 30:
                    risk_users.append({
                        **user_info,
                        'risk': 'NEVER_RECEIVED_CREDITS',
                        'details': f'Subscribed {days_since_subscription} days ago, never got credits'
                    })
        
        self.report['summary'] = {
            'total_active_subscriptions': total_users,
            'recently_granted_users': len(users_by_category['recently_granted']),
            'overdue_users': len(users_by_category['overdue_grant']),
            'never_granted_users': len(users_by_category['never_granted']),
            'normal_users': len(users_by_category['normal']),
            'high_risk_users': len(risk_users)
        }
        
        self.report['risk_users'] = risk_users
        self.report['users_by_category'] = users_by_category
        
        self._generate_recommendations()
        
        return self.report
    
    def _generate_recommendations(self):
        recommendations = []
        
        if self.report['summary']['recently_granted_users'] > 0:
            recommendations.append({
                'priority': 'HIGH',
                'issue': f"{self.report['summary']['recently_granted_users']} users received credits in the last 25 days",
                'action': "Migration will protect these users from double-crediting by setting their next_credit_grant appropriately"
            })
        
        if self.report['summary']['overdue_users'] > 0:
            recommendations.append({
                'priority': 'HIGH',
                'issue': f"{self.report['summary']['overdue_users']} users are overdue for credits (>35 days)",
                'action': "After migration, run the test_credit_renewal.py script with --all-due flag to grant overdue credits"
            })
        
        if self.report['summary']['never_granted_users'] > 0:
            recommendations.append({
                'priority': 'CRITICAL',
                'issue': f"{self.report['summary']['never_granted_users']} users never received any credits",
                'action': "Investigate these users manually and grant initial credits after migration"
            })
        
        boundary_users = [u for u in self.report['risk_users'] if u.get('risk') == 'RECENT_MONTH_BOUNDARY_GRANT']
        if boundary_users:
            recommendations.append({
                'priority': 'MEDIUM',
                'issue': f"{len(boundary_users)} users got credits near month boundary (1st-5th)",
                'action': "These users are protected but monitor them post-migration"
            })
        
        self.report['recommendations'] = recommendations
    
    def print_report(self):
        print("\n" + "="*80)
        print("BILLING MIGRATION ANALYSIS REPORT")
        print("="*80)
        print(f"Timestamp: {self.report['timestamp']}")
        
        print("\n📊 SUMMARY")
        print("-"*40)
        for key, value in self.report['summary'].items():
            print(f"  {key.replace('_', ' ').title()}: {value}")
        
        print("\n⚠️  HIGH RISK USERS")
        print("-"*40)
        if self.report['risk_users']:
            for user in self.report['risk_users'][:10]:
                print(f"  User: {user['user_id'][:8]}...")
                print(f"    Risk: {user['risk']}")
                if 'details' in user:
                    print(f"    Details: {user['details']}")
                print()
            
            if len(self.report['risk_users']) > 10:
                print(f"  ... and {len(self.report['risk_users']) - 10} more risk users")
        else:
            print("  ✅ No high-risk users identified")
        
        print("\n📋 RECOMMENDATIONS")
        print("-"*40)
        if self.report['recommendations']:
            for rec in self.report['recommendations']:
                emoji = "🔴" if rec['priority'] == 'CRITICAL' else "🟡" if rec['priority'] == 'HIGH' else "🟢"
                print(f"  {emoji} [{rec['priority']}] {rec['issue']}")
                print(f"     → {rec['action']}")
                print()
        else:
            print("  ✅ No specific recommendations")
        
        print("\n" + "="*80)
        print("MIGRATION READINESS: ", end="")
        
        critical_issues = [r for r in self.report['recommendations'] if r['priority'] == 'CRITICAL']
        if critical_issues:
            print("❌ CRITICAL ISSUES FOUND - RESOLVE BEFORE MIGRATION")
        elif self.report['summary']['high_risk_users'] > 10:
            print("⚠️  PROCEED WITH CAUTION - MANY RISK USERS")
        else:
            print("✅ READY FOR MIGRATION")
        
        print("="*80 + "\n")
    
    async def export_report(self, filename: str):
        with open(filename, 'w') as f:
            json.dump(self.report, f, indent=2, default=str)
        logger.info(f"Report exported to {filename}")

async def main():
    parser = argparse.ArgumentParser(description='Analyze billing data before migration')
    parser.add_argument('--export', help='Export report to JSON file')
    
    args = parser.parse_args()
    
    analyzer = BillingMigrationAnalyzer()
    await analyzer.initialize()
    
    report = await analyzer.analyze_existing_users()
    analyzer.print_report()
    
    if args.export:
        await analyzer.export_report(args.export)
    
    print("\n📌 NEXT STEPS:")
    print("-"*40)
    print("1. Review the analysis above")
    print("2. If ready, apply the migration:")
    print("   supabase db push")
    print("3. After migration, handle overdue users:")
    print("   python scripts/test_credit_renewal.py --all-due")
    print("4. Monitor logs for the first few billing cycles")
    print()

if __name__ == '__main__':
    asyncio.run(main()) 