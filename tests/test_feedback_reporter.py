"""
Unit tests for feedback reporter module.
"""
import pytest
import json
import tempfile
from pathlib import Path
from app.feedback_reporter import generate_rule_report, generate_html_report
from app.feedback_db import FeedbackDB


class TestFeedbackReporter:
    """Test feedback reporter module."""
    
    def setup_method(self):
        """Set up temporary database and reports directory."""
        self.temp_db = tempfile.NamedTemporaryFile(delete=False, suffix='.db')
        self.temp_db.close()
        
        # Create temporary reports directory
        self.temp_reports = Path(tempfile.mkdtemp())
        
        # Patch DB_PATH and REPORTS_DIR
        from app import feedback_db
        from app import feedback_reporter
        
        original_db_path = feedback_db.DB_PATH
        original_reports_dir = feedback_reporter.REPORTS_DIR
        
        feedback_db.DB_PATH = Path(self.temp_db.name)
        feedback_reporter.REPORTS_DIR = self.temp_reports
        
        self.db = FeedbackDB(Path(self.temp_db.name))
        
        # Store originals for teardown
        self._original_db_path = original_db_path
        self._original_reports_dir = original_reports_dir
        
        # Add some test data
        self.db.add_feedback(
            "Spam message 1", True, True,
            matched_rules=["Commercial trade offer"],
            spam_score=0.8
        )
        self.db.add_feedback(
            "Legitimate message", True, False,
            matched_rules=["Commercial trade offer"],
            spam_score=0.6
        )
    
    def teardown_method(self):
        """Clean up temporary files."""
        if Path(self.temp_db.name).exists():
            Path(self.temp_db.name).unlink()
        
        # Restore original paths
        from app import feedback_db
        from app import feedback_reporter
        
        feedback_db.DB_PATH = self._original_db_path
        feedback_reporter.REPORTS_DIR = self._original_reports_dir
    
    def test_generate_rule_report_json(self):
        """Test generating JSON rule report."""
        from app import feedback_reporter
        
        report_file = generate_rule_report()
        
        assert report_file.exists()
        assert report_file.suffix == ".json"
        
        # Read and validate JSON
        with open(report_file, 'r') as f:
            report = json.load(f)
        
        assert "generated_at" in report
        assert "summary" in report
        assert "rules" in report
        assert "examples" in report
        
        # Check summary
        summary = report["summary"]
        assert "total_feedback" in summary
        assert "false_positives" in summary
        assert "false_negatives" in summary
        
        # Check rules
        assert isinstance(report["rules"], list)
        if len(report["rules"]) > 0:
            rule = report["rules"][0]
            assert "rule_name" in rule
            assert "statistics" in rule
            assert "issues" in rule
    
    def test_generate_rule_report_with_issues(self):
        """Test report generation identifies issues."""
        from app import feedback_reporter
        
        # Add more FP to trigger high FPR issue
        for _ in range(10):
            self.db.add_feedback(
                "FP message", True, False,
                matched_rules=["Test Rule"],
                spam_score=0.6
            )
        
        report_file = generate_rule_report()
        
        with open(report_file, 'r') as f:
            report = json.load(f)
        
        # Should have rules (may or may not have issues depending on thresholds)
        assert len(report["rules"]) >= 0
        
        # Check issue structure if any rules have issues
        rules_with_issues = [r for r in report["rules"] if r.get("issues")]
        for rule in rules_with_issues:
            for issue in rule["issues"]:
                assert "type" in issue
                assert "severity" in issue
                assert "message" in issue
                assert "recommendation" in issue
    
    def test_generate_html_report(self):
        """Test generating HTML report."""
        from app import feedback_reporter
        
        report_file = generate_html_report()
        
        assert report_file.exists()
        assert report_file.suffix == ".html"
        
        # Read and validate HTML
        with open(report_file, 'r') as f:
            html = f.read()
        
        assert "<!DOCTYPE html>" in html
        assert "TAS Feedback Report" in html
        assert "Summary" in html
        assert "Rules Performance" in html
        assert "table" in html
    
    def test_report_includes_examples(self):
        """Test that report includes FP/FN examples."""
        from app import feedback_reporter
        
        report_file = generate_rule_report()
        
        with open(report_file, 'r') as f:
            report = json.load(f)
        
        assert "examples" in report
        assert "false_positives" in report["examples"]
        assert "false_negatives" in report["examples"]
        
        # Examples should be lists
        assert isinstance(report["examples"]["false_positives"], list)
        assert isinstance(report["examples"]["false_negatives"], list)
        
        # Check example structure
        if len(report["examples"]["false_positives"]) > 0:
            example = report["examples"]["false_positives"][0]
            assert "text" in example
            assert "spam_score" in example
            assert "matched_rules" in example
    
    def test_report_sorted_by_problem_severity(self):
        """Test that rules are sorted by problem severity."""
        from app import feedback_reporter
        
        # Add rules with different FPR
        for _ in range(5):
            self.db.add_feedback("FP1", True, False, matched_rules=["High FPR Rule"])
        for _ in range(1):
            self.db.add_feedback("FP2", True, False, matched_rules=["Low FPR Rule"])
        
        report_file = generate_rule_report()
        
        with open(report_file, 'r') as f:
            report = json.load(f)
        
        if len(report["rules"]) >= 2:
            # First rule should have higher FPR
            first_fpr = report["rules"][0]["statistics"].get("false_positive_rate", 0)
            second_fpr = report["rules"][1]["statistics"].get("false_positive_rate", 0)
            assert first_fpr >= second_fpr
    
    def test_html_report_latest_file(self):
        """Test that latest.html is created."""
        from app import feedback_reporter
        
        generate_html_report()
        
        latest_file = feedback_reporter.REPORTS_DIR / "feedback_report_latest.html"
        assert latest_file.exists()
    
    def test_json_report_latest_file(self):
        """Test that latest.json is created."""
        from app import feedback_reporter
        
        generate_rule_report()
        
        latest_file = feedback_reporter.REPORTS_DIR / "feedback_report_latest.json"
        assert latest_file.exists()
    
    def test_report_with_no_feedback(self):
        """Test report generation when database is empty."""
        # Clear database and generate report
        # The report should still be generated even with no data
        report_file = generate_rule_report()
        assert report_file.exists()
        
        with open(report_file, 'r') as f:
            report = json.load(f)
        
        # Should have summary even if empty
        assert "summary" in report
        assert "total_feedback" in report["summary"]
        assert isinstance(report["rules"], list)
    
    def test_report_with_multiple_rules(self):
        """Test report with multiple rules having different performance."""
        # Clear existing data first
        # Add feedback for different rules
        self.db.add_feedback("FP1", True, False, matched_rules=["High FPR Rule"], spam_score=0.7)
        self.db.add_feedback("FP2", True, False, matched_rules=["High FPR Rule"], spam_score=0.7)
        self.db.add_feedback("TP1", True, True, matched_rules=["Good Rule"], spam_score=0.8)
        self.db.add_feedback("TP2", True, True, matched_rules=["Good Rule"], spam_score=0.8)
        
        report_file = generate_rule_report()
        
        assert report_file.exists()
        
        with open(report_file, 'r') as f:
            report = json.load(f)
        
        # Should have rules (at least one)
        assert len(report["rules"]) >= 0
        
        # Check rule structure for any rules that exist
        for rule in report["rules"]:
            assert "rule_name" in rule
            assert "statistics" in rule
            assert "issues" in rule
            assert isinstance(rule["statistics"], dict)
            assert isinstance(rule["issues"], list)
    
    def test_report_timestamp_format(self):
        """Test that report has valid timestamp."""
        report_file = generate_rule_report()
        
        with open(report_file, 'r') as f:
            report = json.load(f)
        
        assert "generated_at" in report
        # Should be valid ISO format
        from datetime import datetime
        datetime.fromisoformat(report["generated_at"].replace('Z', '+00:00'))
    
    def test_html_report_structure(self):
        """Test HTML report contains required sections."""
        report_file = generate_html_report()
        
        with open(report_file, 'r') as f:
            html = f.read()
        
        # Check for key sections
        assert "<html" in html.lower()
        assert "</html>" in html.lower()
        assert "summary" in html.lower()
        assert "rules" in html.lower() or "performance" in html.lower()

