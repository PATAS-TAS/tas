"""
Feedback reporter - generates reports on FP/FN per rule.
"""
import json
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Dict
from app.feedback_db import feedback_db


REPORTS_DIR = Path(__file__).parent.parent / "reports"
REPORTS_DIR.mkdir(exist_ok=True)


def generate_rule_report() -> Path:
    """Generate comprehensive report on FP/FN per rule."""
    rule_stats = feedback_db.get_rule_stats()
    summary = feedback_db.get_summary()
    
    # Get recent feedback entries
    fp_entries = feedback_db.get_feedback(error_type="fp", limit=50)
    fn_entries = feedback_db.get_feedback(error_type="fn", limit=50)
    
    # Generate report
    report: Dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": summary,
        "rules": []
    }
    
    # Sort rules by problem severity (high FPR + high FP count)
    sorted_rules = sorted(
        rule_stats.items(),
        key=lambda x: (
            x[1].get("false_positive_rate", 0.0) * x[1].get("false_positives", 0),
            x[1].get("false_negatives", 0)
        ),
        reverse=True
    )
    
    for rule_name, stats in sorted_rules:
        rule_report: Dict[str, Any] = {
            "rule_name": rule_name,
            "statistics": stats,
            "issues": []
        }
        
        fpr = stats.get("false_positive_rate", 0.0)
        fp_count = stats.get("false_positives", 0)
        fn_count = stats.get("false_negatives", 0)
        precision = stats.get("precision", 0.0)
        recall = stats.get("recall", 0.0)
        
        # Identify issues
        if fpr > 0.10 and fp_count >= 5:
            rule_report["issues"].append({
                "type": "high_fpr",
                "severity": "high" if fpr > 0.20 else "medium",
                "message": f"False Positive Rate is {fpr:.1%} with {fp_count} false positives",
                "recommendation": "Refine pattern or add negative context checks"
            })
        
        if fn_count >= 10:
            rule_report["issues"].append({
                "type": "high_fnr",
                "severity": "high" if fn_count >= 20 else "medium",
                "message": f"{fn_count} false negatives detected",
                "recommendation": "Expand pattern or lower score threshold"
            })
        
        if precision < 0.70 and fp_count > 0:
            rule_report["issues"].append({
                "type": "low_precision",
                "severity": "medium",
                "message": f"Precision is {precision:.1%}",
                "recommendation": "Make pattern more specific"
            })
        
        if recall < 0.50 and fn_count > 0:
            rule_report["issues"].append({
                "type": "low_recall",
                "severity": "medium",
                "message": f"Recall is {recall:.1%}",
                "recommendation": "Make pattern broader or add variations"
            })
        
        report["rules"].append(rule_report)
    
    # Add example FP/FN entries
    report["examples"] = {
        "false_positives": [
            {
                "text": entry["text"][:200] + ("..." if len(entry["text"]) > 200 else ""),
                "spam_score": entry.get("spam_score"),
                "matched_rules": entry.get("matched_rules", [])
            }
            for entry in fp_entries[:10]
        ],
        "false_negatives": [
            {
                "text": entry["text"][:200] + ("..." if len(entry["text"]) > 200 else ""),
                "spam_score": entry.get("spam_score"),
                "matched_rules": entry.get("matched_rules", [])
            }
            for entry in fn_entries[:10]
        ]
    }
    
    # Save report
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    report_file = REPORTS_DIR / f"feedback_report_{timestamp}.json"
    
    with open(report_file, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    
    # Also save latest
    latest_file = REPORTS_DIR / "feedback_report_latest.json"
    with open(latest_file, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    
    return report_file


def generate_html_report() -> Path:
    """Generate HTML report for engineers."""
    rule_stats = feedback_db.get_rule_stats()
    summary = feedback_db.get_summary()
    
    # Sort rules by problem severity
    sorted_rules = sorted(
        rule_stats.items(),
        key=lambda x: (
            x[1].get("false_positive_rate", 0.0) * x[1].get("false_positives", 0),
            x[1].get("false_negatives", 0)
        ),
        reverse=True
    )
    
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    
    html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>TAS Feedback Report - {timestamp}</title>
    <style>
        body {{ font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }}
        .container {{ max-width: 1400px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }}
        h1 {{ color: #333; }}
        h2 {{ color: #666; border-bottom: 2px solid #ddd; padding-bottom: 10px; }}
        .summary {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }}
        .summary-card {{ background: #f9f9f9; padding: 15px; border-radius: 5px; border-left: 4px solid #007bff; }}
        .summary-value {{ font-size: 24px; font-weight: bold; color: #333; }}
        .summary-label {{ color: #666; margin-top: 5px; }}
        table {{ width: 100%; border-collapse: collapse; margin: 20px 0; }}
        th, td {{ padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }}
        th {{ background: #f8f9fa; font-weight: bold; }}
        .issue-high {{ background: #fff3cd; color: #856404; padding: 3px 8px; border-radius: 3px; font-size: 11px; }}
        .issue-medium {{ background: #d1ecf1; color: #0c5460; padding: 3px 8px; border-radius: 3px; font-size: 11px; }}
        .bad {{ color: #dc3545; font-weight: bold; }}
        .good {{ color: #28a745; font-weight: bold; }}
        .warning {{ color: #ffc107; font-weight: bold; }}
    </style>
</head>
<body>
    <div class="container">
        <h1>📊 TAS Feedback Report</h1>
        <p><strong>Generated:</strong> {timestamp}</p>
        
        <h2>Summary</h2>
        <div class="summary">
            <div class="summary-card">
                <div class="summary-value">{summary['total_feedback']}</div>
                <div class="summary-label">Total Feedback</div>
            </div>
            <div class="summary-card">
                <div class="summary-value" style="color: #dc3545;">{summary['false_positives']}</div>
                <div class="summary-label">False Positives</div>
            </div>
            <div class="summary-card">
                <div class="summary-value" style="color: #dc3545;">{summary['false_negatives']}</div>
                <div class="summary-label">False Negatives</div>
            </div>
            <div class="summary-card">
                <div class="summary-value">{summary['unique_rules']}</div>
                <div class="summary-label">Unique Rules Tracked</div>
            </div>
        </div>
        
        <h2>Rules Performance</h2>
        <table>
            <tr>
                <th>Rule Name</th>
                <th>Total Matches</th>
                <th>False Positives</th>
                <th>False Negatives</th>
                <th>Precision</th>
                <th>Recall</th>
                <th>F1 Score</th>
                <th>FPR</th>
                <th>Issues</th>
            </tr>
"""
    
    for rule_name, stats in sorted_rules:
        fpr = stats.get("false_positive_rate", 0.0)
        fp_count = stats.get("false_positives", 0)
        fn_count = stats.get("false_negatives", 0)
        precision = stats.get("precision", 0.0)
        recall = stats.get("recall", 0.0)
        f1 = stats.get("f1_score", 0.0)
        
        # Determine issues
        issues = []
        if fpr > 0.10 and fp_count >= 5:
            issues.append(f'<span class="issue-high">High FPR ({fpr:.1%})</span>')
        if fn_count >= 10:
            issues.append(f'<span class="issue-medium">High FN ({fn_count})</span>')
        if precision < 0.70:
            issues.append('<span class="issue-medium">Low Precision</span>')
        if recall < 0.50:
            issues.append('<span class="issue-medium">Low Recall</span>')
        
        precision_class = "good" if precision >= 0.85 else "warning" if precision >= 0.70 else "bad"
        recall_class = "good" if recall >= 0.70 else "warning" if recall >= 0.50 else "bad"
        fpr_class = "good" if fpr < 0.05 else "warning" if fpr < 0.10 else "bad"
        
        html += f"""
            <tr>
                <td><strong>{rule_name}</strong></td>
                <td>{stats.get('total_matches', 0)}</td>
                <td class="bad">{fp_count}</td>
                <td class="bad">{fn_count}</td>
                <td class="{precision_class}">{precision:.2%}</td>
                <td class="{recall_class}">{recall:.2%}</td>
                <td>{f1:.2%}</td>
                <td class="{fpr_class}">{fpr:.2%}</td>
                <td>{' '.join(issues) if issues else '-'}</td>
            </tr>
"""
    
    html += """
        </table>
        
        <hr>
        <p style="color: #666; font-size: 12px;">Generated by TAS Feedback System</p>
    </div>
</body>
</html>
"""
    
    timestamp_file = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    report_file = REPORTS_DIR / f"feedback_report_{timestamp_file}.html"
    
    with open(report_file, 'w', encoding='utf-8') as f:
        f.write(html)
    
    # Also save latest
    latest_file = REPORTS_DIR / "feedback_report_latest.html"
    with open(latest_file, 'w', encoding='utf-8') as f:
        f.write(html)
    
    return report_file
