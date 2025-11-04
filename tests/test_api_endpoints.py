"""
Comprehensive API endpoints testing.
"""
import pytest
import httpx
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


class TestHealthEndpoint:
    def test_health_check(self):
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "version" in data
    
    def test_health_structure(self):
        response = client.get("/health")
        data = response.json()
        assert "ml_model" in data
        assert "llm_enabled" in data
        assert "cache_size" in data


class TestRootEndpoint:
    def test_root_response(self):
        response = client.get("/")
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "TAS - Transmodal Anti-Spam API"
        assert "endpoints" in data
        assert "classify" in data["endpoints"]
    
    def test_root_endpoints_list(self):
        response = client.get("/")
        data = response.json()
        endpoints = data["endpoints"]
        assert "classify" in endpoints
        assert "health" in endpoints


class TestClassifyEndpoint:
    def test_classify_success(self):
        response = client.post(
            "/classify",
            json={"text": "Hello, how are you?", "lang": "en"}
        )
        assert response.status_code == 200
        data = response.json()
        assert "is_spam" in data
        assert "confidence" in data
        assert "reason" in data
        assert isinstance(data["is_spam"], bool)
        assert 0 <= data["confidence"] <= 1
    
    def test_classify_spam_detection(self):
        response = client.post(
            "/classify",
            json={"text": "Продам iPhone 12, недорого! Звоните +79001234567", "lang": "en"}
        )
        assert response.status_code == 200
        data = response.json()
        assert "is_spam" in data
        assert isinstance(data["is_spam"], bool)
    
    def test_classify_missing_text(self):
        response = client.post("/classify", json={"lang": "en"})
        assert response.status_code == 422
    
    def test_classify_empty_text(self):
        response = client.post("/classify", json={"text": "", "lang": "en"})
        assert response.status_code == 422
    
    def test_classify_very_long_text(self):
        long_text = "A" * 9000
        response = client.post("/classify", json={"text": long_text, "lang": "en"})
        assert response.status_code in [200, 422]
    
    def test_classify_unicode(self):
        response = client.post(
            "/classify",
            json={"text": "Привет! 🎉 你好 مرحبا", "lang": "en"}
        )
        assert response.status_code == 200
    
    def test_classify_only_whitespace(self):
        response = client.post("/classify", json={"text": "   \n\t  ", "lang": "en"})
        assert response.status_code == 200
    
    def test_classify_special_characters(self):
        response = client.post(
            "/classify",
            json={"text": "!@#$%^&*()_+-=[]{}|;':\",./<>?", "lang": "en"}
        )
        assert response.status_code == 200




class TestErrorHandling:
    def test_invalid_json(self):
        response = client.post(
            "/classify",
            content="invalid json",
            headers={"Content-Type": "application/json"}
        )
        assert response.status_code == 422
    
    def test_missing_content_type(self):
        response = client.post("/classify", data="text=hello")
        assert response.status_code in [422, 400]
    
    def test_nonexistent_endpoint(self):
        response = client.get("/nonexistent")
        assert response.status_code == 404

