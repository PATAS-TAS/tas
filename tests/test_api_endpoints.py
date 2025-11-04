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
        assert "batch" in endpoints
        assert "patterns" in endpoints
        assert "stats" in endpoints
        assert "health" in endpoints


class TestClassifyEndpoint:
    def test_classify_success(self):
        response = client.post(
            "/classify",
            json={"text": "Hello, how are you?", "lang": "en"}
        )
        assert response.status_code == 200
        data = response.json()
        assert "spam_score" in data
        assert "confidence" in data
        assert "labels" in data
        assert "category" in data
        assert "reasons" in data
        assert "layers_used" in data
        assert "version" in data
    
    def test_classify_spam_detection(self):
        response = client.post(
            "/classify",
            json={"text": "Продам iPhone 12, недорого! Звоните +79001234567", "lang": "en"}
        )
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data["spam_score"], (int, float))
        assert 0 <= data["spam_score"] <= 1
    
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


class TestBatchEndpoint:
    def test_batch_success(self):
        response = client.post(
            "/batch",
            json={"texts": ["Hello", "World", "Test"]}
        )
        assert response.status_code == 200
        data = response.json()
        assert "results" in data
        assert len(data["results"]) == 3
    
    def test_batch_empty_list(self):
        response = client.post("/batch", json={"texts": []})
        assert response.status_code == 422
    
    def test_batch_too_many(self):
        texts = [f"Text {i}" for i in range(101)]
        response = client.post("/batch", json={"texts": texts})
        assert response.status_code == 422
    
    def test_batch_mixed_content(self):
        response = client.post(
            "/batch",
            json={
                "texts": [
                    "Hello, how are you?",
                    "Продам iPhone, звоните!",
                    "Normal conversation text"
                ]
            }
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["results"]) == 3


class TestPatternsEndpoint:
    def test_patterns_list(self):
        response = client.get("/patterns")
        assert response.status_code == 200
        data = response.json()
        assert "total" in data
        assert "patterns" in data
        assert isinstance(data["patterns"], list)
        assert len(data["patterns"]) > 0
    
    def test_patterns_structure(self):
        response = client.get("/patterns")
        data = response.json()
        if data["patterns"]:
            pattern = data["patterns"][0]
            assert "reason" in pattern
            assert "score" in pattern
            assert "pattern" in pattern


class TestStatsEndpoint:
    def test_stats_response(self):
        response = client.get("/stats")
        assert response.status_code == 200
        data = response.json()
        assert "version" in data
        assert "thresholds" in data
        assert "ml_model" in data
        assert "cache" in data
    
    def test_stats_thresholds(self):
        response = client.get("/stats")
        data = response.json()
        thresholds = data["thresholds"]
        assert "rules" in thresholds
        assert "ml" in thresholds
        assert "llm_fallback" in thresholds


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

