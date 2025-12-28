from typing import Dict, Any, Optional
from decimal import Decimal
from dataclasses import dataclass, field

@dataclass
class VoiceConfig:
    provider: str = "11labs"
    voice_id: str = "EXAVITQu4vr4xnSDxMaL"
    settings: Dict[str, Any] = field(default_factory=lambda: {
        "speed": 1.0,
        "stability": 0.5,
        "similarity_boost": 0.75
    })

@dataclass
class ModelConfig:
    provider: str = "openai"
    model: str = "gpt-5-mini"
    temperature: float = 0.7
    max_tokens: Optional[int] = None
    messages: list = field(default_factory=lambda: [
        {
            "role": "system",
            "content": "You are a helpful AI assistant on a phone call. Be concise and natural in your responses. Speak conversationally and avoid long monologues."
        }
    ])

@dataclass
class TranscriberConfig:
    provider: str = "deepgram"
    model: str = "nova-2"
    language: str = "multi"
    smart_format: bool = True

@dataclass
class VapiConfig:
    voice: VoiceConfig = field(default_factory=VoiceConfig)
    model: ModelConfig = field(default_factory=ModelConfig)
    transcriber: TranscriberConfig = field(default_factory=TranscriberConfig)
    
    first_message_default: str = "Hello, this is an AI assistant calling. How can I help you today?"
    max_duration_seconds: int = 600
    
    voice_options: Dict[str, Dict[str, str]] = field(default_factory=lambda: {
        "11labs": {
            "EXAVITQu4vr4xnSDxMaL": "Sarah/Bella (Female, Multilingual - Default)"
        },
        "azure": {
            "multilingual-auto": "Automatic Multilingual",
            "en-US-AriaNeural": "Aria (Female, US English)",
            "en-US-GuyNeural": "Guy (Male, US English)",
            "es-ES-ElviraNeural": "Elvira (Female, Spanish)",
            "fr-FR-DeniseNeural": "Denise (Female, French)",
            "de-DE-KatjaNeural": "Katja (Female, German)"
        },
        "playht": {
            "jennifer-playht": "Jennifer (Female, American)",
            "matthew-playht": "Matthew (Male, American)"
        }
    })
    
    model_options: Dict[str, list] = field(default_factory=lambda: {
        "openai": [
            "gpt-4",
            "gpt-4-turbo",
            "gpt-3.5-turbo",
            "gpt-3.5-turbo-16k"
        ],
        "anthropic": [
            "claude-3-opus",
            "claude-3-sonnet",
            "claude-3-haiku"
        ]
    })
    
    server_message_types: list = field(default_factory=lambda: [
        "conversation-update",
        "end-of-call-report",
        "function-call",
        "hang",
        "speech-update",
        "status-update",
        "transcript",
        "tool-calls",
        "user-interrupted",
        "voice-input"
    ])
    
    webhook_events: list = field(default_factory=lambda: [
        "conversation-update",
        "end-of-call-report",
        "status-update",
        "transcript"
    ])
    
    cost_per_minute_base: Decimal = field(default=Decimal("0.05"))
    cost_per_minute_transcription: Decimal = field(default=Decimal("0.01"))
    cost_per_minute_voice: Decimal = field(default=Decimal("0.02"))
    cost_per_minute_model: Decimal = field(default=Decimal("0.02"))
    
    def calculate_call_cost(self, duration_seconds: int) -> Decimal:
        if duration_seconds <= 0:
            return Decimal("0")
        
        duration_minutes = Decimal(duration_seconds) / Decimal("60")
        
        base_cost = duration_minutes * self.cost_per_minute_base
        transcription_cost = duration_minutes * self.cost_per_minute_transcription
        voice_cost = duration_minutes * self.cost_per_minute_voice
        model_cost = duration_minutes * self.cost_per_minute_model
        
        return base_cost + transcription_cost + voice_cost + model_cost
    
    def get_assistant_config(self, 
                           system_prompt: Optional[str] = None,
                           first_message: Optional[str] = None,
                           voice_id: Optional[str] = None,
                           model: Optional[str] = None) -> Dict[str, Any]:
        
        messages = self.model.messages.copy()
        if system_prompt:
            messages[0]["content"] = system_prompt
        
        config = {
            "firstMessage": first_message or self.first_message_default,
            "model": {
                "provider": self.model.provider,
                "model": model or self.model.model,
                "temperature": self.model.temperature,
                "messages": messages
            },
            "voice": {
                "provider": self.voice.provider,
                "voiceId": voice_id or self.voice.voice_id
            },
            "transcriber": {
                "provider": self.transcriber.provider,
                "model": self.transcriber.model,
                "language": self.transcriber.language,
                "smartFormat": self.transcriber.smart_format
            },
            "maxDurationSeconds": self.max_duration_seconds,
            "serverMessages": self.server_message_types
        }

        if self.model.max_tokens:
            config["model"]["maxTokens"] = self.model.max_tokens
        
        if self.voice.settings:
            if self.voice.settings.get("speed", 1.0) != 1.0:
                config["voice"]["speed"] = self.voice.settings["speed"]
        
        return config

vapi_config = VapiConfig()

DEFAULT_SYSTEM_PROMPT = """You are a professional AI assistant making a phone call.

Language Instructions:
- You can speak and understand: English, Spanish, French, German, Italian, Portuguese, Japanese, Chinese, Korean, Hindi, Russian, Arabic, Dutch, Polish, Turkish, Swedish, Norwegian, Danish, Greek, Hebrew, Thai, Vietnamese, Indonesian, Malay, Bengali, Czech, Hungarian, Romanian, and Ukrainian
- Automatically detect and respond in the user's language
- Switch languages seamlessly when the user changes languages
- Maintain consistent personality across all languages
- Use culturally appropriate greetings and formality levels

Your goals are:
1. Be natural and conversational - speak as if you're having a real phone conversation
2. Be concise - avoid long explanations unless specifically asked
3. Listen actively and respond appropriately
4. Be helpful and friendly
5. If you don't know something, admit it honestly
6. End the call politely when the conversation is complete"""

DEFAULT_FIRST_MESSAGE = "Hello! I'm an AI assistant and I can communicate in multiple languages. How can I help you today?"

VOICE_PROVIDERS = {
    "11labs": "ElevenLabs",
    "azure": "Azure",
    "playht": "PlayHT",
    "deepgram": "Deepgram",
    "openai": "OpenAI"
}

MODEL_PROVIDERS = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "groq": "Groq"
}
