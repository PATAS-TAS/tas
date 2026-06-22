"""
Unit tests for CLI module.
"""
import pytest
import json
import sys
from pathlib import Path
from click.testing import CliRunner
from app.cli import cli, stats, budget, alerts
from app.metrics import metrics_collector


class TestCLICommands:
    """Test CLI commands."""
    
    def setup_method(self):
        """Reset metrics before each test."""
        # Reset daily cost and clear windows
        metrics_collector._daily_cost = 0.0
        metrics_collector.daily_budget_usd = 10.0
        metrics_collector.monthly_budget_usd = 300.0
        metrics_collector._latency_window.clear()
        metrics_collector._fp_window.clear()
        metrics_collector._fn_window.clear()
        metrics_collector._tp_window.clear()
        metrics_collector._tn_window.clear()
    
    def test_stats_command_table(self):
        """Test stats command with table format."""
        runner = CliRunner()
        result = runner.invoke(cli, ['stats'])
        
        assert result.exit_code == 0
        assert "TAS Statistics" in result.output
        assert "Performance Metrics" in result.output
        assert "Quality Metrics" in result.output
        assert "LLM Metrics" in result.output
        assert "Cost Metrics" in result.output
    
    def test_stats_command_json(self):
        """Test stats command with JSON format."""
        runner = CliRunner()
        result = runner.invoke(cli, ['stats', '--format', 'json'])
        
        assert result.exit_code == 0
        output = json.loads(result.output)
        assert "metrics" in output
        assert "alerts" in output
        assert "total_requests" in output["metrics"]
        assert "fpr" in output["metrics"]
        assert "llm_cost_usd" in output["metrics"]
    
    def test_stats_command_prometheus(self):
        """Test stats command with Prometheus format."""
        runner = CliRunner()
        result = runner.invoke(cli, ['stats', '--format', 'prometheus'])
        
        assert result.exit_code == 0
        assert "tas_total_requests" in result.output
        assert "tas_spam_detected" in result.output
    
    def test_stats_command_alerts_only(self):
        """Test stats command with --alerts flag."""
        runner = CliRunner()
        result = runner.invoke(cli, ['stats', '--alerts'])
        
        assert result.exit_code == 0
        # Should show alerts or "No alerts" message
        assert "alerts" in result.output.lower() or "no alerts" in result.output.lower()
    
    def test_stats_command_with_alerts(self):
        """Test stats command when alerts are present."""
        # Trigger FPR alert
        metrics_collector.record_evaluation_result(tp=0, fp=10, tn=0, fn=0)
        
        runner = CliRunner()
        result = runner.invoke(cli, ['stats'])
        
        assert result.exit_code == 0
        # Should show alerts section
        assert "Active Alerts" in result.output or "No active alerts" in result.output
    
    def test_budget_command_get(self):
        """Test budget command to get current budgets."""
        runner = CliRunner()
        result = runner.invoke(cli, ['budget'])
        
        assert result.exit_code == 0
        assert "Current budgets" in result.output
        assert "$" in result.output
    
    def test_budget_command_set_daily(self):
        """Test budget command to set daily budget."""
        runner = CliRunner()
        result = runner.invoke(cli, ['budget', '--daily', '20.0'])
        
        assert result.exit_code == 0
        assert "Daily budget set" in result.output
        assert metrics_collector.daily_budget_usd == 20.0
    
    def test_budget_command_set_monthly(self):
        """Test budget command to set monthly budget."""
        runner = CliRunner()
        result = runner.invoke(cli, ['budget', '--monthly', '500.0'])
        
        assert result.exit_code == 0
        assert "Monthly budget set" in result.output
        assert metrics_collector.monthly_budget_usd == 500.0
    
    def test_budget_command_set_both(self):
        """Test budget command to set both budgets."""
        runner = CliRunner()
        result = runner.invoke(cli, ['budget', '--daily', '15.0', '--monthly', '400.0'])
        
        assert result.exit_code == 0
        assert metrics_collector.daily_budget_usd == 15.0
        assert metrics_collector.monthly_budget_usd == 400.0
    
    def test_alerts_command_no_alerts(self):
        """Test alerts command when no alerts."""
        # Clear any existing alerts
        metrics_collector._fp_window.clear()
        metrics_collector._fn_window.clear()
        metrics_collector._daily_cost = 0.0
        
        runner = CliRunner()
        result = runner.invoke(cli, ['alerts'])
        
        assert result.exit_code == 0
        # Should show "No active alerts" or similar
        assert "No active alerts" in result.output or "within thresholds" in result.output
    
    def test_alerts_command_with_alerts(self):
        """Test alerts command when alerts are present."""
        # Trigger alerts
        metrics_collector.record_evaluation_result(tp=0, fp=10, tn=0, fn=0)
        metrics_collector._daily_cost = 12.0  # Exceed budget
        
        runner = CliRunner()
        result = runner.invoke(cli, ['alerts'])
        
        assert result.exit_code == 0
        assert "active alert" in result.output.lower()
        assert "FPR" in result.output or "cost" in result.output.lower()
    
    def test_cli_help(self):
        """Test CLI help command."""
        runner = CliRunner()
        result = runner.invoke(cli, ['--help'])
        
        assert result.exit_code == 0
        assert "TAS CLI" in result.output
        assert "stats" in result.output
        assert "budget" in result.output
        assert "alerts" in result.output
    
    def test_stats_help(self):
        """Test stats command help."""
        runner = CliRunner()
        result = runner.invoke(cli, ['stats', '--help'])
        
        assert result.exit_code == 0
        assert "Display current metrics" in result.output
        assert "--format" in result.output
        assert "--alerts" in result.output

