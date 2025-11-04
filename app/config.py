from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    openai_api_key: str = ""
    model_name: str = "unitary/multilingual-toxic-xlm-roberta"
    
    rules_threshold: float = 0.55  # Balanced for precision and recall
    ml_threshold: float = 0.65  # Balanced for precision and recall
    ml_safe_threshold: float = 0.15  # If ML score < this, consider safe (skip LLM)
    llm_fallback: bool = True
    
    cache_size: int = 10000
    cache_ttl: int = 3600
    
    class Config:
        env_file = ".env"
        case_sensitive = False
        extra = "ignore"


settings = Settings()

