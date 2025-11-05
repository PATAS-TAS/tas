#!/usr/bin/env python3
"""
Auto-generate D+3 and D+7 reports
Usage: python generate_auto_report.py --days 3
"""

import json
import sys
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, Any

REPORTS_DIR = Path("reports")
REPORTS_DIR.mkdir(parents=True, exist_ok=True)


def load_metrics() -> Dict[str, Any]:
    """Load latest metrics"""
    metrics_files = sorted(REPORTS_DIR.glob("metrics_*.json"), reverse=True)
    if not metrics_files:
        return {}
    
    with open(metrics_files[0]) as f:
        return json.load(f)


def generate_report(days: int) -> str:
    """Generate report for D+N days"""
    metrics = load_metrics()
    
    report = f"""# D+{days} Launch Report

**Date**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S UTC')}
**Days Since Launch**: {days}

## User Metrics

- **Activations**: [To be filled manually]
- **Paying Users**: [To be filled manually]
- **Free Tier Users**: [To be filled manually]
- **Conversion Rate**: [To be filled manually]

## Performance Metrics

- **P95 Latency (rules-only)**: {metrics.get('latency', {}).get('p95', {}).get('rules_only', 'N/A')}ms
- **P95 Latency (with LLM)**: {metrics.get('latency', {}).get('p95', {}).get('with_llm', 'N/A')}ms
- **P99 Latency (rules-only)**: {metrics.get('latency', {}).get('p99', {}).get('rules_only', 'N/A')}ms
- **P99 Latency (with LLM)**: {metrics.get('latency', {}).get('p99', {}).get('with_llm', 'N/A')}ms

## Quality Metrics

- **LLM Hit Rate**: {metrics.get('llm_hit_rate', 0):.1%}
- **Cache Hit Rate**: {metrics.get('llm_cache_hit_rate', 0):.1%}
- **False Positive Rate**: {metrics.get('fpr', 0):.1%}
- **Recall**: {metrics.get('recall', 0):.1%}
- **F1 Score**: {metrics.get('f1', 0):.1%}

## Cost Metrics

- **Cost/Day**: ${metrics.get('llm_daily_cost_usd', 0):.2f}
- **Cost/Month (projected)**: ${metrics.get('llm_monthly_cost_usd', 0):.2f}
- **Budget Utilization**: {metrics.get('llm_daily_cost_usd', 0) / max(metrics.get('daily_budget_usd', 1), 1) * 100:.1f}%

## Top Issues

### False Positives
[Top 5 FP reasons to be filled manually]

### False Negatives
[Top 5 FN reasons to be filled manually]

## Recommendations

### Pricing
- [Review pricing based on actual usage]

### Limits
- [Review rate limits and quotas]

### Features
- [Feature requests from users]

## Next Steps

1. [Action items]
2. [Action items]
3. [Action items]
"""
    
    return report


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Generate auto-report")
    parser.add_argument("--days", type=int, required=True, help="Days since launch (3 or 7)")
    
    args = parser.parse_args()
    
    if args.days not in [3, 7]:
        print("Error: --days must be 3 or 7")
        sys.exit(1)
    
    report = generate_report(args.days)
    report_file = REPORTS_DIR / f"D{args.days}.md"
    
    with open(report_file, 'w') as f:
        f.write(report)
    
    print(f"✅ Generated: {report_file}")
    print("⚠️  Please fill in user metrics and recommendations manually")

