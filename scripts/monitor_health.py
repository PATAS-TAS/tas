#!/usr/bin/env python3
"""
Monitor system health and send alerts if issues detected.
"""

import json
import sys
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Dict, Any
import logging

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.feedback_db import FeedbackDB

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class HealthMonitor:
    """Monitor system health metrics."""
    
    def __init__(self):
        self.feedback_db = FeedbackDB()
        self.alerts_file = Path("logs/health_alerts.log")
        self.alerts_file.parent.mkdir(parents=True, exist_ok=True)
    
    def check_feedback_health(self) -> Dict[str, Any]:
        """Check feedback collection health."""
        summary = self.feedback_db.get_summary()
        
        # Check if feedback is being collected
        issues = []
        warnings = []
        
        if summary['total_feedback'] == 0:
            warnings.append("No feedback collected yet - system waiting for data")
        
        # Check feedback ratio
        if summary['total_feedback'] > 0:
            fp_ratio = summary['false_positives'] / summary['total_feedback']
            fn_ratio = summary['false_negatives'] / summary['total_feedback']
            
            if fp_ratio > 0.20:  # More than 20% FP
                issues.append(f"High FP ratio: {fp_ratio:.1%}")
            
            if fn_ratio > 0.20:  # More than 20% FN
                issues.append(f"High FN ratio: {fn_ratio:.1%}")
        
        return {
            "status": "healthy" if not issues else "unhealthy",
            "summary": summary,
            "issues": issues,
            "warnings": warnings
        }
    
    def check_automation_health(self) -> Dict[str, Any]:
        """Check automation system health."""
        issues = []
        warnings = []
        
        # Check if reports are being generated
        reports_dir = Path("reports/auto_improvement")
        if reports_dir.exists():
            cycles = list(reports_dir.glob("cycle_*.json"))
            if cycles:
                latest_cycle = max(cycles, key=lambda p: p.stat().st_mtime)
                age = datetime.now(timezone.utc) - datetime.fromtimestamp(
                    latest_cycle.stat().st_mtime, tz=timezone.utc
                )
                
                if age.days > 7:
                    warnings.append(f"Last improvement cycle was {age.days} days ago")
            else:
                warnings.append("No improvement cycles run yet")
        else:
            warnings.append("Improvement reports directory not found")
        
        # Check if logs are being written
        logs_dir = Path("logs")
        if logs_dir.exists():
            log_files = list(logs_dir.glob("*.log"))
            if not log_files:
                warnings.append("No log files found - automation may not be running")
        else:
            warnings.append("Logs directory not found")
        
        return {
            "status": "healthy" if not issues else "unhealthy",
            "issues": issues,
            "warnings": warnings
        }
    
    def check_database_health(self) -> Dict[str, Any]:
        """Check database health."""
        issues = []
        
        db_path = Path("feedback.db")
        if not db_path.exists():
            issues.append("Feedback database not found")
            return {"status": "unhealthy", "issues": issues}
        
        # Check database size
        size_mb = db_path.stat().st_size / (1024 * 1024)
        if size_mb > 100:  # More than 100MB
            warnings = [f"Database size is large: {size_mb:.1f}MB"]
        else:
            warnings = []
        
        return {
            "status": "healthy",
            "size_mb": round(size_mb, 2),
            "issues": issues,
            "warnings": warnings
        }
    
    def generate_health_report(self) -> Dict[str, Any]:
        """Generate comprehensive health report."""
        feedback_health = self.check_feedback_health()
        automation_health = self.check_automation_health()
        database_health = self.check_database_health()
        
        overall_status = "healthy"
        if (feedback_health["status"] == "unhealthy" or 
            automation_health["status"] == "unhealthy" or
            database_health["status"] == "unhealthy"):
            overall_status = "unhealthy"
        
        report = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "overall_status": overall_status,
            "feedback": feedback_health,
            "automation": automation_health,
            "database": database_health
        }
        
        # Log alerts
        if overall_status == "unhealthy" or feedback_health.get("issues") or automation_health.get("issues"):
            alert_msg = f"[ALERT] System health check: {overall_status}"
            logger.warning(alert_msg)
            with open(self.alerts_file, 'a') as f:
                f.write(f"{datetime.now(timezone.utc).isoformat()} - {alert_msg}\n")
                for issue in feedback_health.get("issues", []):
                    f.write(f"  - Feedback: {issue}\n")
                for issue in automation_health.get("issues", []):
                    f.write(f"  - Automation: {issue}\n")
        
        return report
    
    def save_report(self, report: Dict[str, Any]) -> Path:
        """Save health report to file."""
        reports_dir = Path("reports/health")
        reports_dir.mkdir(parents=True, exist_ok=True)
        
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        report_file = reports_dir / f"health_{timestamp}.json"
        
        with open(report_file, 'w') as f:
            json.dump(report, f, indent=2)
        
        # Also save latest
        latest_file = reports_dir / "health_latest.json"
        with open(latest_file, 'w') as f:
            json.dump(report, f, indent=2)
        
        return report_file


def main():
    monitor = HealthMonitor()
    report = monitor.generate_health_report()
    report_file = monitor.save_report(report)
    
    print("🏥 System Health Report")
    print("=" * 60)
    print(f"Overall Status: {report['overall_status'].upper()}")
    print(f"Timestamp: {report['timestamp']}")
    print()
    
    print("Feedback Health:")
    print(f"  Status: {report['feedback']['status']}")
    if report['feedback'].get('issues'):
        for issue in report['feedback']['issues']:
            print(f"  ⚠️  {issue}")
    if report['feedback'].get('warnings'):
        for warning in report['feedback']['warnings']:
            print(f"  ℹ️  {warning}")
    print()
    
    print("Automation Health:")
    print(f"  Status: {report['automation']['status']}")
    if report['automation'].get('issues'):
        for issue in report['automation']['issues']:
            print(f"  ⚠️  {issue}")
    if report['automation'].get('warnings'):
        for warning in report['automation']['warnings']:
            print(f"  ℹ️  {warning}")
    print()
    
    print("Database Health:")
    print(f"  Status: {report['database']['status']}")
    if report['database'].get('size_mb'):
        print(f"  Size: {report['database']['size_mb']}MB")
    print()
    
    print(f"Report saved: {report_file}")
    
    # Exit with error code if unhealthy
    if report['overall_status'] == "unhealthy":
        sys.exit(1)
    
    sys.exit(0)


if __name__ == "__main__":
    main()

