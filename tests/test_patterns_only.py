"""
Test patterns layer only (without ML/LLM dependencies).
Useful for testing when ML model or LLM is not available.
"""
import asyncio
import csv
from pathlib import Path
from app.regex_patterns import regex_patterns
from app.config import settings


async def test_patterns_only():
    csv_path = Path(__file__).parent.parent.parent / "report.csv"
    
    if not csv_path.exists():
        print(f"report.csv not found at {csv_path}")
        return
    
    total = 0
    correct = 0
    true_positives = 0
    false_positives = 0
    true_negatives = 0
    false_negatives = 0
    
    pattern_stats = {}
    
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        
        for i, row in enumerate(reader):
            if i >= 500:  # Limit for faster testing
                break
            
            message = row.get('Message Content', '').strip()
            if not message:
                continue
            
            is_spam = row.get('Is Spam', '').strip()
            if is_spam not in ['0', '1']:
                continue
            
            expected = int(is_spam) == 1
            
            # Test rules layer only
            rule_results = regex_patterns.check(message)
            rule_score = sum(score for _, score in rule_results) / max(len(rule_results), 1) if rule_results else 0.0
            rule_score = min(rule_score, 0.95)
            
            predicted = rule_score >= settings.rules_threshold
            
            # Track pattern matches
            for reason, score in rule_results:
                if reason not in pattern_stats:
                    pattern_stats[reason] = {"matches": 0, "correct": 0, "total_score": 0.0}
                pattern_stats[reason]["matches"] += 1
                pattern_stats[reason]["total_score"] += score
            
            total += 1
            
            if predicted == expected:
                correct += 1
                if predicted:
                    true_positives += 1
                else:
                    true_negatives += 1
            else:
                if predicted:
                    false_positives += 1
                else:
                    false_negatives += 1
            
            if i % 50 == 0:
                print(f"Processed {i} rows...")
    
    accuracy = (correct / total) * 100 if total > 0 else 0
    precision = (true_positives / (true_positives + false_positives)) * 100 if (true_positives + false_positives) > 0 else 0
    recall = (true_positives / (true_positives + false_negatives)) * 100 if (true_positives + false_negatives) > 0 else 0
    f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0
    
    print("\n" + "="*50)
    print("TAS Patterns-Only Test Results (report.csv)")
    print("="*50)
    print(f"Total tested: {total}")
    print(f"Accuracy: {accuracy:.2f}%")
    print(f"Precision: {precision:.2f}%")
    print(f"Recall: {recall:.2f}%")
    print(f"F1 Score: {f1:.2f}%")
    print("\nConfusion Matrix:")
    print(f"  True Positives: {true_positives}")
    print(f"  False Positives: {false_positives}")
    print(f"  True Negatives: {true_negatives}")
    print(f"  False Negatives: {false_negatives}")
    print("\nPattern Statistics (top 10):")
    sorted_patterns = sorted(pattern_stats.items(), key=lambda x: x[1]["matches"], reverse=True)
    for reason, stats in sorted_patterns[:10]:
        avg_score = stats["total_score"] / stats["matches"] if stats["matches"] > 0 else 0
        print(f"  {reason}: {stats['matches']} matches, avg_score={avg_score:.2f}")
    print("="*50)


if __name__ == "__main__":
    asyncio.run(test_patterns_only())

