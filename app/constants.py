"""
Application constants for TAS.

This module contains all magic numbers and configuration constants
used throughout the application to improve code readability and maintainability.
"""
from typing import Final

# =============================================================================
# Scoring Thresholds
# =============================================================================

# Minimum score for a module to contribute to the final spam score
MODULE_SCORE_THRESHOLD: Final[float] = 0.3

# Boost applied when multiple commercial patterns are detected
MULTI_PATTERN_BOOST: Final[float] = 0.1

# Maximum score cap for combined rules
MAX_RULE_SCORE: Final[float] = 0.95

# Score threshold for early exit (skip LLM)
EARLY_EXIT_SCORE_THRESHOLD: Final[float] = 0.8

# LLM spam confidence threshold
LLM_SPAM_THRESHOLD: Final[float] = 0.5

# Weight for LLM score when it doesn't detect spam
LLM_LOW_CONFIDENCE_WEIGHT: Final[float] = 0.3

# Weight for vision score contribution
VISION_SCORE_WEIGHT: Final[float] = 0.8

# Vision rule score weight
VISION_RULE_WEIGHT: Final[float] = 0.7

# =============================================================================
# Rate Limiting
# =============================================================================

# Default rate limit for API requests
DEFAULT_RATE_LIMIT_REQUESTS: Final[int] = 100
DEFAULT_RATE_LIMIT_WINDOW_SECONDS: Final[int] = 60

# =============================================================================
# LLM Configuration
# =============================================================================

# Maximum text length for LLM analysis
LLM_MAX_TEXT_LENGTH: Final[int] = 500

# LLM retry configuration
LLM_MAX_RETRIES: Final[int] = 3
LLM_BACKOFF_DELAYS: Final[tuple[float, ...]] = (0.5, 1.0, 2.0)

# Circuit breaker configuration
CIRCUIT_BREAKER_FAILURE_THRESHOLD: Final[int] = 3
CIRCUIT_BREAKER_RECOVERY_SECONDS: Final[int] = 120

# =============================================================================
# Cache Configuration
# =============================================================================

# Default cache sizes
DEFAULT_CACHE_SIZE: Final[int] = 10000
DEFAULT_CACHE_TTL: Final[int] = 3600

# LLM cache defaults
DEFAULT_LLM_CACHE_SIZE: Final[int] = 5000
DEFAULT_LLM_CACHE_TTL: Final[int] = 86400

# URL cache defaults
DEFAULT_URL_CACHE_SIZE: Final[int] = 5000
DEFAULT_URL_CACHE_TTL: Final[int] = 86400

# =============================================================================
# Reputation & Rate Sentinel (RRS)
# =============================================================================

# Message burst detection
RRS_BURST_THRESHOLD: Final[int] = 5
RRS_BURST_WINDOW_SECONDS: Final[int] = 60
RRS_MAX_BURST_SCORE: Final[float] = 0.8

# =============================================================================
# Link URL Risk (LUR)
# =============================================================================

# TLD risk scores
HIGH_RISK_TLD_SCORE: Final[float] = 0.7
MEDIUM_RISK_TLD_SCORE: Final[float] = 0.6
LOW_RISK_TLD_SCORE: Final[float] = 0.5

# Short domain risk scores
HIGH_RISK_SHORTENER_SCORE: Final[float] = 0.5
LOW_RISK_SHORTENER_SCORE: Final[float] = 0.4

# Domain length thresholds
SUSPICIOUS_DOMAIN_LENGTH: Final[int] = 10
MODERATE_DOMAIN_LENGTH: Final[int] = 15

# =============================================================================
# Response Formatting
# =============================================================================

# Maximum reasons to include in response
MAX_RESPONSE_REASONS: Final[int] = 5

# Maximum reasons from LLM
MAX_LLM_REASONS: Final[int] = 2

# =============================================================================
# Metrics & Monitoring
# =============================================================================

# Sliding window size for metrics
METRICS_WINDOW_SIZE: Final[int] = 1000

# Trim fraction when window is full
METRICS_TRIM_FRACTION: Final[float] = 0.10

# Minimum samples for P95 calculation
MIN_SAMPLES_FOR_PERCENTILE: Final[int] = 20

# LLM hit rate warning threshold
LLM_HIT_RATE_WARNING: Final[float] = 0.15

# Auto-degrade LLM hit rate threshold
AUTO_DEGRADE_LLM_HIT_RATE: Final[float] = 0.20

# FPR alert threshold
FPR_ALERT_THRESHOLD: Final[float] = 0.05

# Budget warning threshold (percentage)
BUDGET_WARNING_THRESHOLD: Final[float] = 0.80

# =============================================================================
# Commercial Pattern Detection
# =============================================================================

# List of commercial pattern reasons
COMMERCIAL_KEYWORDS: Final[tuple[str, ...]] = (
    "Commercial trade offer",
    "Car sale offer",
    "Real estate offer",
    "Job offer or work solicitation",
    "Service offer",
)

# Contact pattern reasons
CONTACT_PATTERNS: Final[tuple[str, ...]] = (
    "Contains phone number",
    "Contains email",
    "Contains URL",
    "Short URL domain",
    "URL-only message",
)

# High risk pattern reasons
HIGH_RISK_PATTERNS: Final[tuple[str, ...]] = (
    "URL-only message",
    "Crypto/Web3 scam",
    "NSFW/Adult content",
    "Referral/affiliate scheme",
)

# =============================================================================
# API Versioning
# =============================================================================

API_VERSION: Final[str] = "1.0.3"
API_PREFIX: Final[str] = "/v1"
