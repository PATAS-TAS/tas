"""
Nightly evaluator for TAS - automated quality assessment.
Runs stratified evaluation and saves metrics/plots to reports/ directory.
"""
import csv
import sys
import time
import statistics
import random
import asyncio
import json
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, List, Optional
import os

sys.path.insert(0, str(Path(__file__).parent))

from app.pipeline import pipeline
from app.config import settings

# Create reports directory
REPORTS_DIR = Path(__file__).parent / "reports"
REPORTS_DIR.mkdir(exist_ok=True)


def load_stratified_sample(filepath: str, sample_size: int = 1000) -> List[Dict]:
    """Load stratified sample: equal spam/ham."""
    spam_msgs = []
    ham_msgs = []
    
    if not os.path.exists(filepath):
        print(f"Warning: {filepath} not found, using empty sample")
        return []
    
    print(f"Reading {filepath}...")
    with open(filepath, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            message = row.get('Message Content', '').strip()
            is_spam_str = row.get('Is Spam', '').strip()
            
            if not message or not is_spam_str:
                continue
            
            try:
                is_spam = int(is_spam_str) == 1
                if is_spam:
                    spam_msgs.append({'text': message, 'is_spam': True})
                else:
                    ham_msgs.append({'text': message, 'is_spam': False})
            except:
                continue
    
    print(f"Loaded: {len(spam_msgs)} spam, {len(ham_msgs)} ham")
    
    if len(spam_msgs) == 0 or len(ham_msgs) == 0:
        print("Error: Need both spam and ham messages")
        return []
    
    # Stratified sample
    per_class = sample_size // 2
    spam_sample = random.sample(spam_msgs, min(per_class, len(spam_msgs)))
    ham_sample = random.sample(ham_msgs, min(per_class, len(ham_msgs)))
    
    combined = spam_sample + ham_sample
    random.shuffle(combined)
    
    print(f"Selected sample: {len(combined)} messages ({len(spam_sample)} spam, {len(ham_sample)} ham)")
    
    return combined


async def evaluate_async(messages: List[Dict], threshold: float = 0.5) -> Dict:
    """Evaluate TAS on messages (async)."""
    tp = fp = tn = fn = 0
    latencies = []
    errors = []
    
    print(f"\nEvaluating {len(messages)} messages with threshold {threshold}...")
    
    for i, msg in enumerate(messages):
        if (i + 1) % 100 == 0:
            print(f"  Progress: {i+1}/{len(messages)} ({100*(i+1)/len(messages):.1f}%)")
        
        start = time.time()
        try:
            result = await pipeline.classify(msg['text'][:8192], "ru")
            score = result.get('spam_score', 0.0)
        except Exception as e:
            errors.append(f"Message {i}: {str(e)}")
            continue
        
        latency = (time.time() - start) * 1000
        latencies.append(latency)
        
        pred = score >= threshold
        actual = msg['is_spam']
        
        if pred and actual:
            tp += 1
        elif pred and not actual:
            fp += 1
        elif not pred and not actual:
            tn += 1
        else:
            fn += 1
    
    # Metrics
    total = tp + fp + tn + fn
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0
    fpr = fp / (fp + tn) if (fp + tn) > 0 else 0.0
    fnr = fn / (fn + tp) if (fn + tp) > 0 else 0.0
    accuracy = (tp + tn) / total if total > 0 else 0.0
    
    avg_latency = statistics.mean(latencies) if latencies else 0.0
    p50_latency = statistics.median(latencies) if latencies else 0.0
    p95_latency = statistics.quantiles(latencies, n=20)[18] if len(latencies) >= 20 else avg_latency
    p99_latency = statistics.quantiles(latencies, n=100)[98] if len(latencies) >= 100 else p95_latency
    min_latency = min(latencies) if latencies else 0.0
    max_latency = max(latencies) if latencies else 0.0
    
    return {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'threshold': threshold,
        'total': total,
        'tp': tp, 'fp': fp, 'tn': tn, 'fn': fn,
        'precision': round(precision, 4),
        'recall': round(recall, 4),
        'f1': round(f1, 4),
        'fpr': round(fpr, 4),
        'fnr': round(fnr, 4),
        'accuracy': round(accuracy, 4),
        'latency': {
            'avg_ms': round(avg_latency, 2),
            'p50_ms': round(p50_latency, 2),
            'p95_ms': round(p95_latency, 2),
            'p99_ms': round(p99_latency, 2),
            'min_ms': round(min_latency, 2),
            'max_ms': round(max_latency, 2)
        },
        'errors': len(errors),
        'version': getattr(pipeline, 'version', '1.0.3')
    }


def save_metrics(results: Dict, output_dir: Path) -> Path:
    """Save metrics to JSON file."""
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    metrics_file = output_dir / f"metrics_{timestamp}.json"
    
    with open(metrics_file, 'w') as f:
        json.dump(results, f, indent=2)
    
    # Also save latest
    latest_file = output_dir / "metrics_latest.json"
    with open(latest_file, 'w') as f:
        json.dump(results, f, indent=2)
    
    print(f"Metrics saved to {metrics_file}")
    return metrics_file


def load_history(output_dir: Path) -> List[Dict]:
    """Load historical metrics for trend analysis."""
    history = []
    for file in sorted(output_dir.glob("metrics_*.json")):
        if file.name == "metrics_latest.json":
            continue
        try:
            with open(file, 'r') as f:
                data = json.load(f)
                history.append(data)
        except Exception as e:
            print(f"Warning: Failed to load {file}: {e}")
    return history


def generate_report(results: Dict, history: List[Dict], output_dir: Path) -> Path:
    """Generate HTML report for engineers."""
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    
    # Check if metrics meet targets
    precision_ok = results['precision'] >= 0.85
    recall_ok = results['recall'] >= 0.70
    f1_ok = results['f1'] >= 0.75
    fpr_ok = results['fpr'] < 0.05
    latency_ok = results['latency']['p95_ms'] < 300
    
    # Calculate trends (compare with previous run if available)
    trends = {}
    if len(history) >= 1:
        prev = history[-1]
        trends = {
            'precision': results['precision'] - prev.get('precision', 0),
            'recall': results['recall'] - prev.get('recall', 0),
            'f1': results['f1'] - prev.get('f1', 0),
            'fpr': results['fpr'] - prev.get('fpr', 0),
            'p95_latency': results['latency']['p95_ms'] - prev.get('latency', {}).get('p95_ms', 0)
        }
    
    html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>TAS Nightly Evaluation Report - {timestamp}</title>
    <style>
        body {{ font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }}
        .container {{ max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }}
        h1 {{ color: #333; }}
        h2 {{ color: #666; border-bottom: 2px solid #ddd; padding-bottom: 10px; }}
        .metrics {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }}
        .metric-card {{ background: #f9f9f9; padding: 15px; border-radius: 5px; border-left: 4px solid #007bff; }}
        .metric-card.ok {{ border-left-color: #28a745; }}
        .metric-card.warning {{ border-left-color: #ffc107; }}
        .metric-card.error {{ border-left-color: #dc3545; }}
        .metric-value {{ font-size: 24px; font-weight: bold; color: #333; }}
        .metric-label {{ color: #666; margin-top: 5px; }}
        .trend {{ font-size: 12px; margin-top: 5px; }}
        .trend.up {{ color: #28a745; }}
        .trend.down {{ color: #dc3545; }}
        table {{ width: 100%; border-collapse: collapse; margin: 20px 0; }}
        th, td {{ padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }}
        th {{ background: #f8f9fa; font-weight: bold; }}
        .status {{ padding: 5px 10px; border-radius: 3px; font-size: 12px; }}
        .status.ok {{ background: #d4edda; color: #155724; }}
        .status.warning {{ background: #fff3cd; color: #856404; }}
        .status.error {{ background: #f8d7da; color: #721c24; }}
    </style>
</head>
<body>
    <div class="container">
        <h1>🔍 TAS Nightly Evaluation Report</h1>
        <p><strong>Generated:</strong> {timestamp}</p>
        <p><strong>Version:</strong> {results.get('version', 'unknown')}</p>
        
        <h2>📊 Key Metrics</h2>
        <div class="metrics">
            <div class="metric-card {'ok' if precision_ok else 'warning' if results['precision'] >= 0.75 else 'error'}">
                <div class="metric-value">{results['precision']:.2%}</div>
                <div class="metric-label">Precision {'✅' if precision_ok else '⚠️' if results['precision'] >= 0.75 else '❌'}</div>
                <div class="metric-label">Target: >85%</div>
                {f"<div class='trend {'up' if trends.get('precision', 0) >= 0 else 'down'}'>{'↑' if trends.get('precision', 0) >= 0 else '↓'} {abs(trends.get('precision', 0)):.2%}</div>" if trends else ""}
            </div>
            <div class="metric-card {'ok' if recall_ok else 'warning' if results['recall'] >= 0.60 else 'error'}">
                <div class="metric-value">{results['recall']:.2%}</div>
                <div class="metric-label">Recall {'✅' if recall_ok else '⚠️' if results['recall'] >= 0.60 else '❌'}</div>
                <div class="metric-label">Target: >70%</div>
                {f"<div class='trend {'up' if trends.get('recall', 0) >= 0 else 'down'}'>{'↑' if trends.get('recall', 0) >= 0 else '↓'} {abs(trends.get('recall', 0)):.2%}</div>" if trends else ""}
            </div>
            <div class="metric-card {'ok' if f1_ok else 'warning' if results['f1'] >= 0.70 else 'error'}">
                <div class="metric-value">{results['f1']:.2%}</div>
                <div class="metric-label">F1 Score {'✅' if f1_ok else '⚠️' if results['f1'] >= 0.70 else '❌'}</div>
                <div class="metric-label">Target: >75%</div>
                {f"<div class='trend {'up' if trends.get('f1', 0) >= 0 else 'down'}'>{'↑' if trends.get('f1', 0) >= 0 else '↓'} {abs(trends.get('f1', 0)):.2%}</div>" if trends else ""}
            </div>
            <div class="metric-card {'ok' if fpr_ok else 'warning' if results['fpr'] < 0.10 else 'error'}">
                <div class="metric-value">{results['fpr']:.2%}</div>
                <div class="metric-label">False Positive Rate {'✅' if fpr_ok else '⚠️' if results['fpr'] < 0.10 else '❌'}</div>
                <div class="metric-label">Target: <5%</div>
                {f"<div class='trend {'down' if trends.get('fpr', 0) <= 0 else 'up'}'>{'↓' if trends.get('fpr', 0) <= 0 else '↑'} {abs(trends.get('fpr', 0)):.2%}</div>" if trends else ""}
            </div>
            <div class="metric-card {'ok' if latency_ok else 'warning' if results['latency']['p95_ms'] < 500 else 'error'}">
                <div class="metric-value">{results['latency']['p95_ms']:.0f}ms</div>
                <div class="metric-label">P95 Latency {'✅' if latency_ok else '⚠️' if results['latency']['p95_ms'] < 500 else '❌'}</div>
                <div class="metric-label">Target: <300ms</div>
                {f"<div class='trend {'down' if trends.get('p95_latency', 0) <= 0 else 'up'}'>{'↓' if trends.get('p95_latency', 0) <= 0 else '↑'} {abs(trends.get('p95_latency', 0)):.0f}ms</div>" if trends else ""}
            </div>
            <div class="metric-card">
                <div class="metric-value">{results['accuracy']:.2%}</div>
                <div class="metric-label">Accuracy</div>
            </div>
        </div>
        
        <h2>📈 Confusion Matrix</h2>
        <table>
            <tr>
                <th></th>
                <th>Predicted: SPAM</th>
                <th>Predicted: HAM</th>
            </tr>
            <tr>
                <th>Actual: SPAM</th>
                <td>{results['tp']} (TP)</td>
                <td>{results['fn']} (FN)</td>
            </tr>
            <tr>
                <th>Actual: HAM</th>
                <td>{results['fp']} (FP)</td>
                <td>{results['tn']} (TN)</td>
            </tr>
        </table>
        
        <h2>⚡ Performance</h2>
        <table>
            <tr>
                <th>Metric</th>
                <th>Value</th>
                <th>Target</th>
                <th>Status</th>
            </tr>
            <tr>
                <td>Average Latency</td>
                <td>{results['latency']['avg_ms']:.2f} ms</td>
                <td>< 200ms</td>
                <td><span class="status {'ok' if results['latency']['avg_ms'] < 200 else 'warning' if results['latency']['avg_ms'] < 400 else 'error'}">{'✅' if results['latency']['avg_ms'] < 200 else '⚠️' if results['latency']['avg_ms'] < 400 else '❌'}</span></td>
            </tr>
            <tr>
                <td>P50 Latency</td>
                <td>{results['latency']['p50_ms']:.2f} ms</td>
                <td>-</td>
                <td>-</td>
            </tr>
            <tr>
                <td>P95 Latency</td>
                <td>{results['latency']['p95_ms']:.2f} ms</td>
                <td>< 300ms</td>
                <td><span class="status {'ok' if latency_ok else 'warning' if results['latency']['p95_ms'] < 500 else 'error'}">{'✅' if latency_ok else '⚠️' if results['latency']['p95_ms'] < 500 else '❌'}</span></td>
            </tr>
            <tr>
                <td>P99 Latency</td>
                <td>{results['latency']['p99_ms']:.2f} ms</td>
                <td>< 700ms</td>
                <td><span class="status {'ok' if results['latency']['p99_ms'] < 700 else 'warning' if results['latency']['p99_ms'] < 1000 else 'error'}">{'✅' if results['latency']['p99_ms'] < 700 else '⚠️' if results['latency']['p99_ms'] < 1000 else '❌'}</span></td>
            </tr>
            <tr>
                <td>Min Latency</td>
                <td>{results['latency']['min_ms']:.2f} ms</td>
                <td>-</td>
                <td>-</td>
            </tr>
            <tr>
                <td>Max Latency</td>
                <td>{results['latency']['max_ms']:.2f} ms</td>
                <td>-</td>
                <td>-</td>
            </tr>
        </table>
        
        <h2>📋 Summary</h2>
        <ul>
            <li><strong>Total messages:</strong> {results['total']}</li>
            <li><strong>Threshold:</strong> {results['threshold']}</li>
            <li><strong>Errors:</strong> {results['errors']}</li>
            {'<li><strong>⚠️ Warnings:</strong> Some metrics below target</li>' if not (precision_ok and recall_ok and f1_ok and fpr_ok and latency_ok) else '<li><strong>✅ All metrics meet targets</strong></li>'}
        </ul>
        
        {f"""
        <h2>📊 Recent History ({len(history)} runs)</h2>
        <table>
            <tr>
                <th>Date</th>
                <th>Precision</th>
                <th>Recall</th>
                <th>F1</th>
                <th>FPR</th>
                <th>P95 Latency</th>
            </tr>
            {''.join([f"<tr><td>{h.get('timestamp', '')[:10]}</td><td>{h.get('precision', 0):.2%}</td><td>{h.get('recall', 0):.2%}</td><td>{h.get('f1', 0):.2%}</td><td>{h.get('fpr', 0):.2%}</td><td>{h.get('latency', {}).get('p95_ms', 0):.0f}ms</td></tr>" for h in history[-10:]])}
        </table>
        """ if history else ""}
        
        <hr>
        <p style="color: #666; font-size: 12px;">Generated by TAS Nightly Evaluator</p>
    </div>
</body>
</html>
"""
    
    report_file = output_dir / f"report_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.html"
    with open(report_file, 'w', encoding='utf-8') as f:
        f.write(html)
    
    # Also save latest
    latest_report = output_dir / "report_latest.html"
    with open(latest_report, 'w', encoding='utf-8') as f:
        f.write(html)
    
    print(f"Report saved to {report_file}")
    return report_file


def generate_plots(results: Dict, history: List[Dict], output_dir: Path) -> Optional[List[Path]]:
    """Generate trend plots (if matplotlib available)."""
    try:
        import matplotlib
        matplotlib.use('Agg')  # Non-interactive backend
        import matplotlib.pyplot as plt
        import matplotlib.dates as mdates
        from datetime import datetime
    except ImportError:
        print("matplotlib not available, skipping plots")
        return None
    
    if len(history) < 2:
        print("Not enough history for plots, need at least 2 runs")
        return None
    
    plots = []
    
    # Parse timestamps
    dates = []
    precisions = []
    recalls = []
    f1s = []
    fprs = []
    p95_latencies = []
    
    for h in history + [results]:
        try:
            dt = datetime.fromisoformat(h['timestamp'].replace('Z', '+00:00'))
            dates.append(dt)
            precisions.append(h['precision'])
            recalls.append(h['recall'])
            f1s.append(h['f1'])
            fprs.append(h['fpr'])
            p95_latencies.append(h['latency']['p95_ms'])
        except Exception as e:
            print(f"Warning: Failed to parse timestamp: {e}")
            continue
    
    if len(dates) < 2:
        return None
    
    # Plot 1: Precision/Recall/F1 over time
    fig, ax = plt.subplots(figsize=(12, 6))
    ax.plot(dates, precisions, label='Precision', marker='o', linewidth=2)
    ax.plot(dates, recalls, label='Recall', marker='s', linewidth=2)
    ax.plot(dates, f1s, label='F1 Score', marker='^', linewidth=2)
    ax.axhline(y=0.85, color='g', linestyle='--', alpha=0.5, label='Precision Target')
    ax.axhline(y=0.70, color='b', linestyle='--', alpha=0.5, label='Recall Target')
    ax.axhline(y=0.75, color='r', linestyle='--', alpha=0.5, label='F1 Target')
    ax.set_xlabel('Date')
    ax.set_ylabel('Score')
    ax.set_title('TAS Performance Metrics Over Time')
    ax.legend()
    ax.grid(True, alpha=0.3)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m-%d'))
    ax.xaxis.set_major_locator(mdates.DayLocator(interval=max(1, len(dates)//10)))
    plt.xticks(rotation=45)
    plt.tight_layout()
    
    plot1_file = output_dir / "trends_metrics.png"
    plt.savefig(plot1_file, dpi=150, bbox_inches='tight')
    plt.close()
    plots.append(plot1_file)
    
    # Plot 2: FPR over time
    fig, ax = plt.subplots(figsize=(12, 6))
    ax.plot(dates, fprs, label='False Positive Rate', marker='o', color='red', linewidth=2)
    ax.axhline(y=0.05, color='g', linestyle='--', alpha=0.5, label='FPR Target (<5%)')
    ax.fill_between(dates, 0, 0.05, alpha=0.2, color='green', label='Safe Zone')
    ax.set_xlabel('Date')
    ax.set_ylabel('False Positive Rate')
    ax.set_title('False Positive Rate Over Time (Lower is Better)')
    ax.legend()
    ax.grid(True, alpha=0.3)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m-%d'))
    ax.xaxis.set_major_locator(mdates.DayLocator(interval=max(1, len(dates)//10)))
    plt.xticks(rotation=45)
    plt.tight_layout()
    
    plot2_file = output_dir / "trends_fpr.png"
    plt.savefig(plot2_file, dpi=150, bbox_inches='tight')
    plt.close()
    plots.append(plot2_file)
    
    # Plot 3: Latency over time
    fig, ax = plt.subplots(figsize=(12, 6))
    ax.plot(dates, p95_latencies, label='P95 Latency', marker='o', color='purple', linewidth=2)
    ax.axhline(y=300, color='g', linestyle='--', alpha=0.5, label='Target (<300ms)')
    ax.axhline(y=700, color='orange', linestyle='--', alpha=0.5, label='Warning (<700ms)')
    ax.set_xlabel('Date')
    ax.set_ylabel('Latency (ms)')
    ax.set_title('P95 Latency Over Time')
    ax.legend()
    ax.grid(True, alpha=0.3)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m-%d'))
    ax.xaxis.set_major_locator(mdates.DayLocator(interval=max(1, len(dates)//10)))
    plt.xticks(rotation=45)
    plt.tight_layout()
    
    plot3_file = output_dir / "trends_latency.png"
    plt.savefig(plot3_file, dpi=150, bbox_inches='tight')
    plt.close()
    plots.append(plot3_file)
    
    print(f"Plots saved: {len(plots)} files")
    return plots


async def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='TAS Nightly Evaluator')
    parser.add_argument('--sample', type=int, default=1000, help='Sample size (default: 1000)')
    parser.add_argument('--threshold', type=float, default=0.35, help='Threshold (default: 0.35)')
    parser.add_argument('--seed', type=int, default=None, help='Random seed (default: current time)')
    parser.add_argument('--file', type=str, default='../report.csv', help='Path to report.csv')
    parser.add_argument('--no-plots', action='store_true', help='Skip plot generation')
    
    args = parser.parse_args()
    
    # Use current time as seed if not provided (different each run)
    if args.seed is None:
        args.seed = int(time.time())
    random.seed(args.seed)
    
    print("="*70)
    print("TAS NIGHTLY EVALUATOR")
    print("="*70)
    print(f"Timestamp: {datetime.now(timezone.utc).isoformat()}")
    print(f"Sample size: {args.sample}")
    print(f"Threshold: {args.threshold}")
    print(f"Seed: {args.seed}")
    print("="*70)
    
    messages = load_stratified_sample(args.file, args.sample)
    
    if not messages:
        print("No messages to evaluate")
        return 1
    
    results = await evaluate_async(messages, args.threshold)
    
    # Save metrics
    metrics_file = save_metrics(results, REPORTS_DIR)
    
    # Load history for trends
    history = load_history(REPORTS_DIR)
    
    # Generate report
    report_file = generate_report(results, history, REPORTS_DIR)
    
    # Generate plots if matplotlib available
    if not args.no_plots:
        plots = generate_plots(results, history, REPORTS_DIR)
        if plots:
            print(f"Generated {len(plots)} plot files")
    
    # Print summary
    print("\n" + "="*70)
    print("EVALUATION SUMMARY")
    print("="*70)
    print(f"Precision: {results['precision']:.2%} {'✅' if results['precision'] >= 0.85 else '⚠️'}")
    print(f"Recall:    {results['recall']:.2%} {'✅' if results['recall'] >= 0.70 else '⚠️'}")
    print(f"F1 Score:  {results['f1']:.2%} {'✅' if results['f1'] >= 0.75 else '⚠️'}")
    print(f"FPR:       {results['fpr']:.2%} {'✅' if results['fpr'] < 0.05 else '⚠️'}")
    print(f"P95 Latency: {results['latency']['p95_ms']:.0f}ms {'✅' if results['latency']['p95_ms'] < 300 else '⚠️'}")
    print("="*70)
    print(f"Metrics: {metrics_file}")
    print(f"Report:  {report_file}")
    print("="*70)
    
    return 0


if __name__ == '__main__':
    exit_code = asyncio.run(main())
    sys.exit(exit_code)

