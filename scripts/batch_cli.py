#!/usr/bin/env python3
"""
Batch classification CLI tool.
Usage: tas batch --file=messages.csv --mode=managed|byo|rules_only --out=results.json
"""
import click
import csv
import json
import sys
import time
from pathlib import Path
from typing import List, Dict
import httpx
from datetime import datetime


@click.command()
@click.option('--file', required=True, help='Input CSV file with messages')
@click.option('--mode', default='managed', type=click.Choice(['managed', 'byo', 'rules_only']), help='LLM mode')
@click.option('--out', default='results.json', help='Output JSON file')
@click.option('--api-key', envvar='TAS_API_KEY', required=True, help='TAS API key')
@click.option('--base-url', default='https://tas.fly.dev', help='TAS API base URL')
@click.option('--byo-provider', help='BYO provider (required if mode=byo)')
@click.option('--byo-key', help='BYO API key (required if mode=byo)')
@click.option('--lang', default='en', help='Default language')
@click.option('--batch-size', default=100, help='Batch size for API calls')
def batch(file: str, mode: str, out: str, api_key: str, base_url: str, byo_provider: str, byo_key: str, lang: str, batch_size: int):
    """Batch classify messages from CSV file."""
    
    if mode == 'byo' and (not byo_provider or not byo_key):
        click.echo("Error: BYO mode requires --byo-provider and --byo-key", err=True)
        sys.exit(1)
    
    # Read CSV file
    messages = []
    try:
        with open(file, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                # Expect 'text' column, optionally 'lang', 'is_spam' (for evaluation)
                messages.append({
                    'text': row.get('text', ''),
                    'lang': row.get('lang', lang),
                    'is_spam': row.get('is_spam', '').strip() == '1' if row.get('is_spam') else None
                })
    except Exception as e:
        click.echo(f"Error reading CSV: {e}", err=True)
        sys.exit(1)
    
    click.echo(f"Processing {len(messages)} messages in mode '{mode}'...")
    
    # Process in batches
    results = []
    stats = {
        'total': len(messages),
        'processed': 0,
        'errors': 0,
        'spam_count': 0,
        'safe_count': 0,
        'latencies': [],
        'start_time': time.time()
    }
    
    headers = {
        'x-api-key': api_key,
        'Content-Type': 'application/json'
    }
    
    if mode != 'managed':
        headers['X-LLM-Mode'] = mode
        if mode == 'byo':
            headers['X-LLM-Provider'] = byo_provider
            headers['X-LLM-Key'] = byo_key
    
    client = httpx.Client(timeout=30.0)
    
    for i in range(0, len(messages), batch_size):
        batch = messages[i:i+batch_size]
        batch_texts = [{'text': m['text'], 'lang': m['lang']} for m in batch]
        
        try:
            start = time.time()
            response = client.post(
                f"{base_url}/v1/batch",
                json=batch_texts,
                headers=headers
            )
            latency = (time.time() - start) * 1000  # ms
            
            if response.status_code == 200:
                batch_results = response.json()
                for j, result in enumerate(batch_results):
                    msg = batch[j]
                    results.append({
                        'input': msg['text'],
                        'expected_spam': msg['is_spam'],
                        'result': result,
                        'latency_ms': latency / len(batch_results)
                    })
                    stats['processed'] += 1
                    if result.get('spam', False):
                        stats['spam_count'] += 1
                    else:
                        stats['safe_count'] += 1
                    stats['latencies'].append(latency / len(batch_results))
            else:
                click.echo(f"Error batch {i//batch_size + 1}: {response.status_code} - {response.text}", err=True)
                stats['errors'] += len(batch)
        except Exception as e:
            click.echo(f"Error processing batch {i//batch_size + 1}: {e}", err=True)
            stats['errors'] += len(batch)
        
        if (i + batch_size) % 1000 == 0:
            click.echo(f"  Progress: {i + batch_size}/{len(messages)}")
    
    client.close()
    
    # Calculate metrics
    total_time = time.time() - stats['start_time']
    latencies = stats['latencies']
    
    metrics = {
        'total': stats['total'],
        'processed': stats['processed'],
        'errors': stats['errors'],
        'spam_count': stats['spam_count'],
        'safe_count': stats['safe_count'],
        'total_time_seconds': total_time,
        'throughput_rps': stats['processed'] / total_time if total_time > 0 else 0,
        'latency_p50_ms': sorted(latencies)[len(latencies)//2] if latencies else 0,
        'latency_p95_ms': sorted(latencies)[int(len(latencies)*0.95)] if latencies else 0,
        'latency_p99_ms': sorted(latencies)[int(len(latencies)*0.99)] if latencies else 0,
    }
    
    # Calculate precision/recall if expected_spam provided
    if any(r.get('expected_spam') is not None for r in results):
        tp = fp = tn = fn = 0
        for r in results:
            expected = r.get('expected_spam')
            if expected is None:
                continue
            predicted = r['result'].get('spam', False)
            if predicted and expected:
                tp += 1
            elif predicted and not expected:
                fp += 1
            elif not predicted and not expected:
                tn += 1
            else:
                fn += 1
        
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0
        fpr = fp / (fp + tn) if (fp + tn) > 0 else 0
        
        metrics['evaluation'] = {
            'tp': tp, 'fp': fp, 'tn': tn, 'fn': fn,
            'precision': precision,
            'recall': recall,
            'f1': f1,
            'fpr': fpr
        }
        
        # Top reasons for FP/FN
        fp_examples = [r for r in results if r.get('expected_spam') == False and r['result'].get('spam')]
        fn_examples = [r for r in results if r.get('expected_spam') == True and not r['result'].get('spam')]
        
        metrics['top_fp_reasons'] = {}
        metrics['top_fn_reasons'] = {}
        
        for r in fp_examples[:10]:
            reasons = r['result'].get('reasons', [])
            for reason in reasons:
                code = reason.get('code', 'unknown')
                metrics['top_fp_reasons'][code] = metrics['top_fp_reasons'].get(code, 0) + 1
        
        for r in fn_examples[:10]:
            reasons = r['result'].get('reasons', [])
            for reason in reasons:
                code = reason.get('code', 'unknown')
                metrics['top_fn_reasons'][code] = metrics['top_fn_reasons'].get(code, 0) + 1
    
    # Save results
    output = {
        'timestamp': datetime.now().isoformat(),
        'mode': mode,
        'metrics': metrics,
        'results': results
    }
    
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    # Print summary
    click.echo("\n=== Summary ===")
    click.echo(f"Total: {metrics['total']}")
    click.echo(f"Processed: {metrics['processed']}")
    click.echo(f"Errors: {metrics['errors']}")
    click.echo(f"Spam: {metrics['spam_count']}, Safe: {metrics['safe_count']}")
    click.echo(f"Throughput: {metrics['throughput_rps']:.2f} rps")
    click.echo(f"Latency P50: {metrics['latency_p50_ms']:.1f}ms, P95: {metrics['latency_p95_ms']:.1f}ms, P99: {metrics['latency_p99_ms']:.1f}ms")
    
    if 'evaluation' in metrics:
        ev = metrics['evaluation']
        click.echo(f"\n=== Evaluation ===")
        click.echo(f"Precision: {ev['precision']:.2%}")
        click.echo(f"Recall: {ev['recall']:.2%}")
        click.echo(f"F1: {ev['f1']:.2%}")
        click.echo(f"FPR: {ev['fpr']:.2%}")
    
    click.echo(f"\nResults saved to: {out}")


if __name__ == '__main__':
    batch()

