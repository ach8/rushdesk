import os
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"

class Settings(BaseSettings):
    # Google AI Studio / Gemini
    gemini_api_key: str = ""
    google_api_key: str = ""
    gemini_model: str = "gemini-3.5-flash-lite"

    # Deepgram
    deepgram_api_key: str = ""

    # Cartesia
    cartesia_api_key: str = ""
    cartesia_voice_id: str = "a0e99841-438c-4a64-b679-ae501e7d6091"  # Default French voice

    # Twilio
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""

    # Backend RushDesk
    rushdesk_api_url: str = "http://localhost:3000/api/voice/submit-order"
    rushdesk_shared_secret: str = ""

    # Server settings
    port: int = 8765
    host: str = "0.0.0.0"
    log_level: str = "INFO"

    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    def get_effective_gemini_key(self) -> str:
        return self.gemini_api_key or self.google_api_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or ""

settings = Settings()
