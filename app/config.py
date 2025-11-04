from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    openai_api_key: str = ""
    patas_url: str = "http://localhost:8000"
    patas_api_key: str = ""
    
    rules_threshold: float = 0.55
    llm_fallback: bool = True
    
    cache_size: int = 10000
    cache_ttl: int = 3600
    
    enable_rrs: bool = True
    enable_lur: bool = True
    enable_sig: bool = True
    enable_rol: bool = False
    enable_qzn: bool = False
    
    class Config:
        env_file = ".env"
        case_sensitive = False
        extra = "ignore"
    
    model_config = {
        "env_file": ".env",
        "case_sensitive": False,
        "extra": "ignore"
    }


settings = Settings()

