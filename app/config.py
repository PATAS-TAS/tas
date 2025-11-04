from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    openai_api_key: str = ""
    
    rules_threshold: float = 0.55  # Balanced for precision and recall
    llm_fallback: bool = True
    
    cache_size: int = 10000
    cache_ttl: int = 3600
    
    class Config:
        env_file = ".env"
        case_sensitive = False
        extra = "ignore"


settings = Settings()

