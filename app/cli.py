"""
CLI tool for TAS - statistics and monitoring.
Usage: tas stats [options]
"""
import click
import sys
from pathlib import Path
from typing import Dict, Any

# Add app to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.metrics import metrics_collector
from app.config import settings


@click.group()
def cli():
    """TAS CLI - Statistics and monitoring."""
    pass


@cli.command()
@click.option('--format', type=click.Choice(['table', 'json', 'prometheus']), default='table', help='Output format')
@click.option('--alerts', is_flag=True, help='Show alerts only')
def stats(format: str, alerts: bool):
    """Display current metrics and statistics."""
    metrics = metrics_collector.get_current_metrics()
    alert_list = metrics_collector.check_alerts()
    
    if alerts:
        # Show only alerts
        if not alert_list:
            click.echo("✅ No alerts - all metrics are within thresholds")
            return
        
        click.echo("⚠️  Active Alerts:")
        click.echo()
        for alert in alert_list:
            severity_icon = "🔴" if alert["severity"] == "critical" else "🟡"
            click.echo(f"{severity_icon} {alert['severity'].upper()}: {alert['message']}")
        return
    
    if format == 'json':
        import json
        output = {
            "metrics": metrics,
            "alerts": alert_list
        }
        click.echo(json.dumps(output, indent=2))
    elif format == 'prometheus':
        from prometheus_client import generate_latest
        click.echo(generate_latest().decode('utf-8'))
    else:
        # Table format
        _print_table(metrics, alert_list)


def _print_table(metrics: Dict[str, Any], alerts: list):
    """Print metrics in a formatted table."""
    click.echo("📊 TAS Statistics")
    click.echo("=" * 70)
    click.echo()
    
    # Performance Metrics
    click.echo("⚡ Performance Metrics:")
    click.echo(f"  Total Requests:      {metrics['total_requests']:,}")
    click.echo(f"  Spam Detected:       {metrics['spam_detected']:,}")
    click.echo(f"  Ham Detected:        {metrics['ham_detected']:,}")
    click.echo(f"  P95 Latency:         {metrics['latency_p95_ms']:.2f} ms")
    click.echo()
    
    # Quality Metrics
    click.echo("🎯 Quality Metrics:")
    fpr = metrics['fpr']
    recall = metrics['recall']
    fpr_status = "✅" if fpr < 0.05 else "⚠️" if fpr < 0.10 else "🔴"
    recall_status = "✅" if recall >= 0.70 else "⚠️" if recall >= 0.50 else "🔴"
    
    click.echo(f"  False Positive Rate: {fpr:.2%} {fpr_status} (target: <5%)")
    click.echo(f"  Recall:              {recall:.2%} {recall_status} (target: >70%)")
    click.echo()
    
    # LLM Metrics
    click.echo("🤖 LLM Metrics:")
    click.echo(f"  LLM Requests:        {metrics['llm_requests']:,}")
    click.echo(f"  Cache Hits:          {metrics['llm_cache_hits']:,}")
    hit_rate = metrics['llm_hit_rate']
    hit_rate_status = "✅" if hit_rate >= 0.15 else "⚠️"
    click.echo(f"  Cache Hit Rate:      {hit_rate:.2%} {hit_rate_status} (target: >15%)")
    click.echo()
    
    # Cost Metrics
    click.echo("💰 Cost Metrics:")
    daily_cost = metrics['llm_daily_cost_usd']
    monthly_cost = metrics['llm_monthly_cost_usd']
    total_cost = metrics['llm_cost_usd']
    daily_budget = metrics['daily_budget_usd']
    monthly_budget = metrics['monthly_budget_usd']
    
    budget_status = "✅" if daily_cost <= daily_budget * 0.8 else "⚠️" if daily_cost <= daily_budget else "🔴"
    click.echo(f"  Daily Cost:          ${daily_cost:.2f} / ${daily_budget:.2f} {budget_status}")
    click.echo(f"  Monthly Cost:        ${monthly_cost:.2f} / ${monthly_budget:.2f}")
    click.echo(f"  Total Cost:          ${total_cost:.2f}")
    
    if metrics['budget_warning']:
        click.echo(f"  ⚠️  Warning: Daily cost is above 80% of budget")
    if metrics['budget_exceeded']:
        click.echo(f"  🔴 Critical: Daily cost exceeds budget!")
    click.echo()
    
    # Alerts
    if alerts:
        click.echo("⚠️  Active Alerts:")
        for alert in alerts:
            severity_icon = "🔴" if alert["severity"] == "critical" else "🟡"
            click.echo(f"  {severity_icon} {alert['severity'].upper()}: {alert['message']}")
        click.echo()
    else:
        click.echo("✅ No active alerts")
        click.echo()
    
    click.echo("=" * 70)


@cli.command()
@click.option('--daily', type=float, help='Set daily budget in USD')
@click.option('--monthly', type=float, help='Set monthly budget in USD')
def budget(daily: float, monthly: float):
    """Set cost budgets."""
    if daily is None and monthly is None:
        current = metrics_collector.get_current_metrics()
        click.echo(f"Current budgets:")
        click.echo(f"  Daily:   ${current['daily_budget_usd']:.2f}")
        click.echo(f"  Monthly: ${current['monthly_budget_usd']:.2f}")
        return
    
    metrics_collector.set_budget(daily=daily, monthly=monthly)
    
    if daily is not None:
        click.echo(f"✅ Daily budget set to ${daily:.2f}")
    if monthly is not None:
        click.echo(f"✅ Monthly budget set to ${monthly:.2f}")


@cli.command()
def alerts():
    """Show current alerts."""
    alert_list = metrics_collector.check_alerts()
    
    if not alert_list:
        click.echo("✅ No active alerts - all metrics are within thresholds")
        return
    
    click.echo(f"⚠️  Found {len(alert_list)} active alert(s):")
    click.echo()
    
    for i, alert in enumerate(alert_list, 1):
        severity_icon = "🔴" if alert["severity"] == "critical" else "🟡"
        click.echo(f"{i}. {severity_icon} {alert['severity'].upper()}: {alert['message']}")
        click.echo(f"   Metric: {alert['metric']}")
        click.echo(f"   Value: {alert['value']}")
        click.echo(f"   Threshold: {alert['threshold']}")
        click.echo()


@cli.command()
def quickstart():
    """Quick start guide - generate .env and run example SDK calls."""
    import os
    from pathlib import Path
    
    click.echo("🚀 TAS Quick Start")
    click.echo("=" * 50)
    click.echo()
    
    # Check .env
    env_file = Path(".env")
    if not env_file.exists():
        click.echo("📝 Creating .env file...")
        if Path("env.example").exists():
            import shutil
            shutil.copy("env.example", ".env")
        else:
            env_file.write_text("""# TAS Configuration
OPENAI_API_KEY=your-key-here
LLM_MODE=managed
DAILY_BUDGET_USD=25.0
""")
        click.echo("✅ Created .env file")
        click.echo("   ⚠️  Please edit .env and set OPENAI_API_KEY")
    else:
        click.echo("✅ .env file exists")
    
    click.echo()
    click.echo("📚 Example SDK Usage:")
    click.echo()
    
    # Python example
    click.echo("Python:")
    click.echo("```python")
    click.echo("from tas_sdk import TASClient")
    click.echo("")
    click.echo("client = TASClient(api_key='your-key')")
    click.echo("result = client.classify('Spam message', lang='en')")
    click.echo("print(f\"Spam: {result['spam']}\")")
    click.echo("```")
    click.echo()
    
    # cURL example
    click.echo("cURL:")
    click.echo("```bash")
    click.echo("curl -X POST https://tas.fly.dev/v1/classify \\")
    click.echo("  -H 'Content-Type: application/json' \\")
    click.echo("  -H 'X-API-Key: your-key' \\")
    click.echo("  -d '{\"text\": \"Spam message\", \"lang\": \"en\"}'")
    click.echo("```")
    click.echo()
    
    click.echo("📖 Full documentation: https://kiku-jw.github.io/tas/")
    click.echo()


@cli.command()
@click.option('--max-llm', type=float, help='Maximum LLM hit rate (0-1, e.g., 0.15 for 15%%)')
@click.option('--max-spend', type=float, help='Maximum daily spend in USD')
@click.option('--dry-run', is_flag=True, help='Show what would be applied without making changes')
def guard(max_llm: float, max_spend: float, dry_run: bool):
    """Set budget guards and LLM limits."""
    import json
    from datetime import datetime
    from pathlib import Path
    
    events_dir = Path("monitoring/events")
    events_dir.mkdir(parents=True, exist_ok=True)
    
    current_metrics = metrics_collector.get_current_metrics()
    changes = []
    
    if max_llm is not None:
        if max_llm < 0 or max_llm > 1:
            click.echo("❌ max-llm must be between 0 and 1 (e.g., 0.15 for 15%%)")
            return
        
        current_llm = current_metrics.get('llm_hit_rate', 0)
        if current_llm > max_llm:
            changes.append({
                "type": "llm_limit_exceeded",
                "current": current_llm,
                "limit": max_llm,
                "action": "auto_degrade_to_rules_only"
            })
            click.echo(f"⚠️  LLM hit rate {current_llm:.1%} exceeds limit {max_llm:.1%}")
            if not dry_run:
                click.echo("   → Auto-degrading to rules-only mode")
        else:
            click.echo(f"✅ LLM hit rate {current_llm:.1%} within limit {max_llm:.1%}")
    
    if max_spend is not None:
        if max_spend < 0:
            click.echo("❌ max-spend must be positive")
            return
        
        current_spend = current_metrics.get('llm_daily_cost_usd', 0)
        if current_spend > max_spend:
            changes.append({
                "type": "budget_exceeded",
                "current": current_spend,
                "limit": max_spend,
                "action": "auto_degrade_to_rules_only"
            })
            click.echo(f"⚠️  Daily spend ${current_spend:.2f} exceeds limit ${max_spend:.2f}")
            if not dry_run:
                click.echo("   → Auto-degrading to rules-only mode")
        else:
            click.echo(f"✅ Daily spend ${current_spend:.2f} within limit ${max_spend:.2f}")
    
    if not dry_run and changes:
        # Apply budget limits
        if max_spend:
            metrics_collector.set_budget(daily=max_spend)
        
        # Log event
        event = {
            "timestamp": datetime.now().isoformat(),
            "guard_settings": {
                "max_llm": max_llm,
                "max_spend": max_spend
            },
            "changes": changes,
            "current_metrics": {
                "llm_hit_rate": current_metrics.get('llm_hit_rate', 0),
                "daily_cost": current_metrics.get('llm_daily_cost_usd', 0)
            }
        }
        
        event_file = events_dir / f"guard_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(event_file, 'w') as f:
            json.dump(event, f, indent=2)
        
        click.echo(f"✅ Guard applied and logged to {event_file}")
    elif dry_run:
        click.echo()
        click.echo("🔍 Dry-run mode - no changes applied")
        if changes:
            click.echo("   Would apply:")
            for change in changes:
                click.echo(f"   - {change['action']}")
        else:
            click.echo("   No changes needed")
    
    if not max_llm and not max_spend:
        click.echo("Usage: tas guard --max-llm 0.15 --max-spend 25.0")
        click.echo("       tas guard --max-llm 0.15 --max-spend 25.0 --dry-run")


if __name__ == '__main__':
    cli()

