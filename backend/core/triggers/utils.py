import json
from typing import Dict, List, Any, Optional
from datetime import datetime, timezone
import croniter
import pytz
from core.utils.logger import logger

class TriggerError(Exception):
    pass


class ConfigurationError(TriggerError):
    pass


class ProviderError(TriggerError):
    pass


def get_next_run_time(cron_expression: str, user_timezone: str) -> Optional[datetime]:
    try:
        tz = pytz.timezone(user_timezone)
        now_local = datetime.now(tz)
        
        cron = croniter.croniter(cron_expression, now_local)
        
        next_run_local = cron.get_next(datetime)
        next_run_utc = next_run_local.astimezone(timezone.utc)
        
        return next_run_utc
        
    except Exception as e:
        logger.error(f"Error calculating next run time: {e}")
        return None


def get_human_readable_schedule(cron_expression: str, user_timezone: str) -> str:
    try:
        patterns = {
            '*/5 * * * *': 'Every 5 minutes',
            '*/10 * * * *': 'Every 10 minutes',
            '*/15 * * * *': 'Every 15 minutes',
            '*/30 * * * *': 'Every 30 minutes',
            '0 * * * *': 'Every hour',
            '0 */2 * * *': 'Every 2 hours',
            '0 */4 * * *': 'Every 4 hours',
            '0 */6 * * *': 'Every 6 hours',
            '0 */12 * * *': 'Every 12 hours',
            '0 0 * * *': 'Daily at midnight',
            '0 9 * * *': 'Daily at 9:00 AM',
            '0 12 * * *': 'Daily at 12:00 PM',
            '0 18 * * *': 'Daily at 6:00 PM',
            '0 9 * * 1-5': 'Weekdays at 9:00 AM',
            '0 9 * * 1': 'Every Monday at 9:00 AM',
            '0 9 * * 2': 'Every Tuesday at 9:00 AM',
            '0 9 * * 3': 'Every Wednesday at 9:00 AM',
            '0 9 * * 4': 'Every Thursday at 9:00 AM',
            '0 9 * * 5': 'Every Friday at 9:00 AM',
            '0 9 * * 6': 'Every Saturday at 9:00 AM',
            '0 9 * * 0': 'Every Sunday at 9:00 AM',
            '0 9 1 * *': 'Monthly on the 1st at 9:00 AM',
            '0 9 15 * *': 'Monthly on the 15th at 9:00 AM',
            '0 9,17 * * *': 'Daily at 9:00 AM and 5:00 PM',
            '0 10 * * 0,6': 'Weekends at 10:00 AM',
        }
        
        if cron_expression in patterns:
            description = patterns[cron_expression]
            if user_timezone != 'UTC':
                description += f" ({user_timezone})"
            return description
        
        parts = cron_expression.split()
        if len(parts) != 5:
            return f"Custom schedule: {cron_expression}"
            
        minute, hour, day, month, weekday = parts

        if minute.isdigit() and hour == '*' and day == '*' and month == '*' and weekday == '*':
            return f"Every hour at :{minute.zfill(2)}"
            
        if minute.isdigit() and hour.isdigit() and day == '*' and month == '*' and weekday == '*':
            time_str = f"{hour.zfill(2)}:{minute.zfill(2)}"
            description = f"Daily at {time_str}"
            if user_timezone != 'UTC':
                description += f" ({user_timezone})"
            return description
            
        if minute.isdigit() and hour.isdigit() and day == '*' and month == '*' and weekday == '1-5':
            time_str = f"{hour.zfill(2)}:{minute.zfill(2)}"
            description = f"Weekdays at {time_str}"
            if user_timezone != 'UTC':
                description += f" ({user_timezone})"
            return description
            
        return f"Custom schedule: {cron_expression}"
        
    except Exception:
        return f"Custom schedule: {cron_expression}"
