"""
PII (Personally Identifiable Information) redaction utilities.
Redacts sensitive data from logs and reports.
"""
import re
from typing import Dict, Any, List
import hashlib


class PIIRedactor:
    """Redacts PII from text and data structures."""
    
    # Patterns for common PII
    EMAIL_PATTERN = re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b')
    PHONE_PATTERN = re.compile(r'(\+?\d{1,3}[-.\s]?)?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}')
    URL_PATTERN = re.compile(r'https?://[^\s]+|www\.[^\s]+')
    URL_REDACT_PATTERN = re.compile(r'(https?://[^\s/]+)([^\s]*)?')
    CREDIT_CARD_PATTERN = re.compile(r'\b\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b')
    IP_PATTERN = re.compile(r'\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b')
    
    def __init__(self, enabled: bool = True):
        self.enabled = enabled
    
    def redact_text(self, text: str) -> str:
        """Redact PII from text string."""
        if not self.enabled or not text:
            return text
        
        result = text
        
        # Redact emails
        result = self.EMAIL_PATTERN.sub('[EMAIL_REDACTED]', result)
        
        # Redact phone numbers
        result = self.PHONE_PATTERN.sub('[PHONE_REDACTED]', result)
        
        # Redact URLs (but keep domain for spam detection)
        # Only redact query parameters and paths
        result = self.URL_REDACT_PATTERN.sub(r'\1[PATH_REDACTED]', result)
        
        # Redact credit cards
        result = self.CREDIT_CARD_PATTERN.sub('[CARD_REDACTED]', result)
        
        # Redact IP addresses
        result = self.IP_PATTERN.sub('[IP_REDACTED]', result)
        
        return result
    
    def redact_dict(self, data: Dict[str, Any], fields_to_redact: List[str] = None) -> Dict[str, Any]:
        """Redact PII from dictionary."""
        if not self.enabled:
            return data
        
        if fields_to_redact is None:
            fields_to_redact = ['text', 'sender_id', 'message_id', 'api_key', 'password', 'token']
        
        result = data.copy()
        
        for key, value in result.items():
            if key in fields_to_redact:
                if isinstance(value, str):
                    result[key] = self.redact_text(value)
                elif isinstance(value, (int, float)):
                    # Hash numeric IDs
                    result[key] = f"ID_{hashlib.md5(str(value).encode()).hexdigest()[:8]}"
            elif isinstance(value, dict):
                result[key] = self.redact_dict(value, fields_to_redact)
            elif isinstance(value, list):
                result[key] = [
                    self.redact_dict(item, fields_to_redact) if isinstance(item, dict)
                    else self.redact_text(item) if isinstance(item, str)
                    else item
                    for item in value
                ]
        
        return result
    
    def hash_identifier(self, identifier: str) -> str:
        """Hash an identifier for session tracking without storing PII."""
        if not identifier:
            return ""
        return hashlib.sha256(identifier.encode()).hexdigest()[:16]


# Global instance
pii_redactor = PIIRedactor(enabled=True)


def redact_log_message(message: str) -> str:
    """Redact PII from log message."""
    return pii_redactor.redact_text(message)


def redact_request_data(data: Dict[str, Any]) -> Dict[str, Any]:
    """Redact PII from request data."""
    return pii_redactor.redact_dict(data)


def hash_api_key(api_key: str) -> str:
    """Hash API key for tracking without storing actual key."""
    return pii_redactor.hash_identifier(api_key)

