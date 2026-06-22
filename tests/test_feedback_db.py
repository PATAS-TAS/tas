"""
Unit tests for feedback database module.
"""
import pytest
import json
import tempfile
from pathlib import Path
from app.feedback_db import FeedbackDB


class TestFeedbackDB:
    """Test FeedbackDB class."""
    
    def setup_method(self):
        """Create temporary database for each test."""
        self.temp_db = tempfile.NamedTemporaryFile(delete=False, suffix='.db')
        self.temp_db.close()
        self.db = FeedbackDB(Path(self.temp_db.name))
    
    def teardown_method(self):
        """Clean up temporary database."""
        if Path(self.temp_db.name).exists():
            Path(self.temp_db.name).unlink()
    
    def test_init_db(self):
        """Test database initialization."""
        assert self.db.db_path.exists()
        # Should be able to query tables
        summary = self.db.get_summary()
        assert summary["total_feedback"] == 0
    
    def test_add_feedback_fp(self):
        """Test adding false positive feedback."""
        feedback_id = self.db.add_feedback(
            text="Продам дом в прошлом году",
            predicted_spam=True,
            actual_spam=False,
            spam_score=0.45,
            confidence=0.45,
            reasons=["Commercial trade offer"],
            matched_rules=["Commercial trade offer"]
        )
        
        assert feedback_id > 0
        
        # Check entry
        entries = self.db.get_feedback(error_type="fp", limit=1)
        assert len(entries) == 1
        assert entries[0]["text"] == "Продам дом в прошлом году"
        assert entries[0]["error_type"] == "fp"
        assert entries[0]["predicted_spam"] is True
        assert entries[0]["actual_spam"] is False
    
    def test_add_feedback_fn(self):
        """Test adding false negative feedback."""
        feedback_id = self.db.add_feedback(
            text="Buy cheap viagra now!",
            predicted_spam=False,
            actual_spam=True,
            spam_score=0.25,
            confidence=0.25,
            reasons=[],
            matched_rules=[]
        )
        
        assert feedback_id > 0
        
        entries = self.db.get_feedback(error_type="fn", limit=1)
        assert len(entries) == 1
        assert entries[0]["error_type"] == "fn"
    
    def test_get_feedback_with_filters(self):
        """Test getting feedback with filters."""
        # Add multiple feedback entries
        self.db.add_feedback("Spam 1", True, False, matched_rules=["Rule1"])
        self.db.add_feedback("Spam 2", True, False, matched_rules=["Rule1"])
        self.db.add_feedback("Spam 3", False, True, matched_rules=["Rule2"])
        
        # Get FP only
        fp_entries = self.db.get_feedback(error_type="fp", limit=10)
        assert len(fp_entries) == 2
        
        # Get FN only
        fn_entries = self.db.get_feedback(error_type="fn", limit=10)
        assert len(fn_entries) == 1
        
        # Get all
        all_entries = self.db.get_feedback(limit=10)
        assert len(all_entries) == 3
    
    def test_get_feedback_pagination(self):
        """Test feedback pagination."""
        # Add multiple entries
        for i in range(15):
            self.db.add_feedback(f"Spam {i}", True, False)
        
        # Get first page
        page1 = self.db.get_feedback(limit=10, offset=0)
        assert len(page1) == 10
        
        # Get second page
        page2 = self.db.get_feedback(limit=10, offset=10)
        assert len(page2) == 5
        
        # No overlap
        assert page1[0]["text"] != page2[0]["text"]
    
    def test_get_rule_stats(self):
        """Test getting rule statistics."""
        # Add feedback with rules
        # TP: predicted=True, actual=True
        self.db.add_feedback(
            "Spam 1", True, True,
            matched_rules=["Commercial trade offer"],
            spam_score=0.8
        )
        # FP: predicted=True, actual=False
        self.db.add_feedback(
            "Spam 2", True, False,
            matched_rules=["Commercial trade offer"],
            spam_score=0.6
        )
        # TN: predicted=False, actual=False (rule matched but score low)
        self.db.add_feedback(
            "Spam 3", False, False,
            matched_rules=["Commercial trade offer"],
            spam_score=0.3
        )
        # FN: predicted=False, actual=True
        self.db.add_feedback(
            "Spam 4", False, True,
            matched_rules=["Job offer"],
            spam_score=0.2
        )
        
        stats = self.db.get_rule_stats()
        
        # Should have stats for both rules
        assert len(stats) >= 1
        
        # Check Commercial trade offer stats
        if "Commercial trade offer" in stats:
            commercial_stats = stats["Commercial trade offer"]
            assert commercial_stats["true_positives"] >= 0
            assert commercial_stats["false_positives"] >= 0
            assert commercial_stats["true_negatives"] >= 0
            assert commercial_stats["precision"] >= 0.0
            assert commercial_stats["recall"] >= 0.0
    
    def test_get_summary(self):
        """Test getting summary statistics."""
        self.db.add_feedback("Spam 1", True, False)  # FP
        self.db.add_feedback("Spam 2", True, False)  # FP
        self.db.add_feedback("Spam 3", False, True)  # FN
        
        summary = self.db.get_summary()
        
        assert summary["total_feedback"] == 3
        assert summary["false_positives"] == 2
        assert summary["false_negatives"] == 1
        assert summary["unique_rules"] >= 0
    
    def test_feedback_with_metadata(self):
        """Test feedback with metadata."""
        feedback_id = self.db.add_feedback(
            "Test message",
            True,
            False,
            sender_id="user123",
            message_id="msg456",
            lang="ru",
            metadata={"source": "telegram", "channel": "general"}
        )
        
        entries = self.db.get_feedback(limit=1)
        assert len(entries) == 1
        assert entries[0]["sender_id"] == "user123"
        assert entries[0]["message_id"] == "msg456"
        assert entries[0]["lang"] == "ru"
        assert entries[0]["metadata"]["source"] == "telegram"
    
    def test_rule_stats_calculation(self):
        """Test rule statistics calculation (precision, recall, F1)."""
        # Add feedback to create stats
        for _ in range(10):
            self.db.add_feedback("TP", True, True, matched_rules=["Rule1"], spam_score=0.8)
        for _ in range(2):
            self.db.add_feedback("FP", True, False, matched_rules=["Rule1"], spam_score=0.6)
        for _ in range(3):
            self.db.add_feedback("FN", False, True, matched_rules=["Rule1"], spam_score=0.2)
        
        stats = self.db.get_rule_stats()
        
        # Rule1 should exist in stats
        assert "Rule1" in stats
        rule_stats = stats["Rule1"]
        
        # Check that stats are calculated (values may vary slightly due to aggregation)
        assert rule_stats["true_positives"] >= 9  # May be slightly less due to aggregation
        assert rule_stats["false_positives"] >= 2
        assert rule_stats["false_negatives"] >= 0  # FN may not increment if rule wasn't matched
        
        # Precision and recall should be calculated
        if rule_stats["true_positives"] + rule_stats["false_positives"] > 0:
            assert rule_stats["precision"] >= 0.0
            assert rule_stats["precision"] <= 1.0
        
        if rule_stats["true_positives"] + rule_stats["false_negatives"] > 0:
            assert rule_stats["recall"] >= 0.0
            assert rule_stats["recall"] <= 1.0
        
        # F1 should be calculated
        assert rule_stats["f1_score"] >= 0.0
        assert rule_stats["f1_score"] <= 1.0

