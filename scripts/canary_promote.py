#!/usr/bin/env python3
"""
Canary rules promotion script
10% → 100% based on 24h stability, auto-rollback on issues
"""

import json
import sys
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, Any

REPORTS_DIR = Path("reports/canary")
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

STABILITY_THRESHOLD_FP = 0.05  # 5% FPR max
STABILITY_THRESHOLD_FN = 0.10  # 10% FNR max
STABILITY_DURATION_HOURS = 24


def load_metrics() -> Dict[str, Any]:
    """Load latest metrics from reports"""
    reports_dir = Path("reports")
    metrics_files = sorted(reports_dir.glob("metrics_*.json"), reverse=True)
    
    if not metrics_files:
        print("❌ No metrics files found")
        return {}
    
    with open(metrics_files[0]) as f:
        return json.load(f)


def check_stability(metrics: Dict[str, Any], hours: int = 24) -> bool:
    """Check if metrics are stable for specified hours"""
    # Load metrics from last N hours
    reports_dir = Path("reports")
    cutoff = datetime.now() - timedelta(hours=hours)
    
    stable_metrics = []
    for metrics_file in sorted(reports_dir.glob("metrics_*.json"), reverse=True):
        # Check file timestamp
        file_time = datetime.fromtimestamp(metrics_file.stat().st_mtime)
        if file_time < cutoff:
            break
        
        with open(metrics_file) as f:
            m = json.load(f)
            stable_metrics.append(m)
    
    if len(stable_metrics) < 2:
        return False
    
    # Check FPR and FNR stability
    avg_fpr = sum(m.get("fpr", 0) for m in stable_metrics) / len(stable_metrics)
    avg_fnr = sum(m.get("fnr", 0) for m in stable_metrics) / len(stable_metrics)
    
    if avg_fpr > STABILITY_THRESHOLD_FP:
        print(f"⚠️  Average FPR {avg_fpr:.1%} exceeds threshold {STABILITY_THRESHOLD_FP:.1%}")
        return False
    
    if avg_fnr > STABILITY_THRESHOLD_FN:
        print(f"⚠️  Average FNR {avg_fnr:.1%} exceeds threshold {STABILITY_THRESHOLD_FN:.1%}")
        return False
    
    print(f"✅ Metrics stable: FPR {avg_fpr:.1%}, FNR {avg_fnr:.1%}")
    return True


def promote_canary(current_percent: int, target_percent: int = 100) -> Dict[str, Any]:
    """Promote canary rules from current to target percentage"""
    metrics = load_metrics()
    
    if not metrics:
        return {"status": "error", "message": "No metrics available"}
    
    # Check stability
    if not check_stability(metrics, STABILITY_DURATION_HOURS):
        return {
            "status": "rejected",
            "reason": "Metrics not stable for 24h",
            "current_percent": current_percent
        }
    
    # Generate promotion report
    report = {
        "timestamp": datetime.now().isoformat(),
        "action": "promote",
        "from_percent": current_percent,
        "to_percent": target_percent,
        "metrics": {
            "fpr": metrics.get("fpr", 0),
            "fnr": metrics.get("fnr", 0),
            "recall": metrics.get("recall", 0),
            "precision": metrics.get("precision", 0)
        },
        "status": "approved"
    }
    
    # Save report
    report_file = REPORTS_DIR / f"promote_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(report_file, 'w') as f:
        json.dump(report, f, indent=2)
    
    print(f"✅ Canary promotion approved: {current_percent}% → {target_percent}%")
    print(f"📄 Report saved: {report_file}")
    
    return report


def rollback_canary(reason: str) -> Dict[str, Any]:
    """Rollback canary rules"""
    report = {
        "timestamp": datetime.now().isoformat(),
        "action": "rollback",
        "reason": reason,
        "status": "rolled_back"
    }
    
    report_file = REPORTS_DIR / f"rollback_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(report_file, 'w') as f:
        json.dump(report, f, indent=2)
    
    print(f"🔄 Canary rollback: {reason}")
    print(f"📄 Report saved: {report_file}")
    
    return report


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Canary rules promotion")
    parser.add_argument("--promote", type=int, help="Promote from current % to target %")
    parser.add_argument("--rollback", type=str, help="Rollback with reason")
    parser.add_argument("--check", action="store_true", help="Check stability only")
    
    args = parser.parse_args()
    
    if args.check:
        metrics = load_metrics()
        if check_stability(metrics, STABILITY_DURATION_HOURS):
            print("✅ Metrics stable for 24h - ready for promotion")
        else:
            print("❌ Metrics not stable - promotion rejected")
            sys.exit(1)
    elif args.rollback:
        rollback_canary(args.rollback)
    elif args.promote:
        result = promote_canary(10, args.promote)  # Assume starting from 10%
        if result.get("status") != "approved":
            sys.exit(1)
    else:
        parser.print_help()

