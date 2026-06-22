import asyncio
import csv
from pathlib import Path
from app.pipeline import pipeline


async def test_report_csv():
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
    
    rules_only = 0
    ml_used = 0
    llm_used = 0
    
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        
        for i, row in enumerate(reader):
            if i >= 1000:
                break
            
            message = row.get('Message Content', '').strip()
            if not message:
                continue
            
            is_spam = row.get('Is Spam', '').strip()
            if is_spam not in ['0', '1']:
                continue
            
            expected = int(is_spam) == 1
            
            result = await pipeline.classify(message)
            predicted = result['spam_score'] >= 0.5
            
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
            
            layers = result.get('layers_used', [])
            if 'llm' in layers:
                llm_used += 1
            elif 'ml' in layers:
                ml_used += 1
            else:
                rules_only += 1
            
            if i % 100 == 0:
                print(f"Processed {i} rows...")
    
    accuracy = (correct / total) * 100 if total > 0 else 0
    precision = (true_positives / (true_positives + false_positives)) * 100 if (true_positives + false_positives) > 0 else 0
    recall = (true_positives / (true_positives + false_negatives)) * 100 if (true_positives + false_negatives) > 0 else 0
    f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0
    
    print("\n" + "="*50)
    print("TAS Test Results (report.csv)")
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
    print("\nLayer Usage:")
    print(f"  Rules only: {rules_only} ({rules_only/total*100:.1f}%)")
    print(f"  ML used: {ml_used} ({ml_used/total*100:.1f}%)")
    print(f"  LLM used: {llm_used} ({llm_used/total*100:.1f}%)")
    print("="*50)


if __name__ == "__main__":
    asyncio.run(test_report_csv())

