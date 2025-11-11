from pydantic_settings import BaseSettings
from pydantic import ConfigDict
from typing import Optional


class Settings(BaseSettings):
    # Prefer PATAS_OPENAI_API_KEY if provided; fallback to OPENAI_API_KEY
    patas_openai_api_key: str = ""
    openai_api_key: str = ""
    patas_url: str = "http://localhost:8000"
    patas_api_key: str = ""
    
    rules_threshold: float = 0.65
    decision_threshold: float = 0.35
    llm_fallback: bool = True
    llm_mode: str = "managed"  # managed, byo, rules_only
    
    cache_size: int = 10000
    cache_ttl: int = 3600
    llm_cache_size: int = 5000
    llm_cache_ttl: int = 86400
    
    enable_rrs: bool = True
    enable_lur: bool = True
    enable_sig: bool = True
    enable_rol: bool = False
    enable_qzn: bool = False
    
    # PII and retention settings
    pii_redaction_enabled: bool = True
    data_retention_days: int = 7  # 0 for immediate deletion
    
    # Vision/Transmodal settings
    vision_enabled: bool = False  # Enable image analysis
    openrouter_api_key: Optional[str] = None  # OpenRouter API key for vision models
    vision_model: str = "openai/gpt-4o-mini"  # Vision model to use
    app_url: str = "https://tas.fly.dev"  # App URL for OpenRouter referer
    
    model_config = ConfigDict(
        env_file=".env",
        case_sensitive=False,
        extra="ignore"
    )


settings = Settings()

