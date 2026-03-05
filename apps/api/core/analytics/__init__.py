"""
Conversation Analytics Module

Provides AI-powered analysis of agent conversations to understand:
- User sentiment and frustration levels
- Use case classification
- Feature request detection
- RFM-based engagement scoring
"""

from core.analytics.conversation_analyzer import (
    queue_for_analysis,
    analyze_conversation,
    calculate_rfm_engagement,
)

__all__ = [
    "queue_for_analysis",
    "analyze_conversation",
    "calculate_rfm_engagement",
]
