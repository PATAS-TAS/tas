import pandas as pd
import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from app.pipeline import pipeline


async def evaluate_on_report():
    report_path = os.path.join(os.path.dirname(__file__), '..', 'report.csv')
    print(f"Загрузка данных из {report_path}...")
    df = pd.read_csv(report_path)
    
    print(f"Всего сообщений: {len(df)}")
    
    spam_column = None
    for col in ['Is Spam', 'is_Spam', 'Is_Spam', 'isSpam']:
        if col in df.columns:
            spam_column = col
            break
    
    if not spam_column:
        print("Ошибка: не найдена колонка с меткой спама")
        print(f"Доступные колонки: {df.columns.tolist()}")
        return
    
    print(f"Спам ({spam_column}=1): {df[spam_column].sum()}")
    print(f"Не спам ({spam_column}=0): {(df[spam_column]==0).sum()}")
    print()
    
    text_column = None
    for col in ['Message Content', 'message', 'text', 'Text', 'Message', 'content', 'Content']:
        if col in df.columns:
            text_column = col
            break
    
    if not text_column:
        print("Ошибка: не найдена колонка с текстом сообщений")
        print(f"Доступные колонки: {df.columns.tolist()}")
        return
    
    print(f"Используется колонка: {text_column}")
    print()
    
    print("Обработка сообщений...")
    results = []
    total = len(df)
    
    for idx, row in df.iterrows():
        if idx % 100 == 0:
            print(f"Обработано: {idx}/{total} ({idx/total*100:.1f}%)")
        
        text = str(row[text_column]) if pd.notna(row[text_column]) else ""
        true_label = int(row[spam_column]) if pd.notna(row[spam_column]) else -1
        
        if not text or len(text.strip()) == 0:
            continue
        
        try:
            result = await pipeline.classify(text, "ru")
            predicted_score = result.get("spam_score", 0.0)
            predicted_label = 1 if predicted_score >= 0.5 else 0
            
            results.append({
                'text': text[:100],
                'true_label': true_label,
                'predicted_label': predicted_label,
                'predicted_score': predicted_score,
                'correct': true_label == predicted_label
            })
        except Exception as e:
            print(f"Ошибка при обработке сообщения {idx}: {e}")
            continue
    
    print(f"\nОбработано сообщений: {len(results)}")
    print()
    
    results_df = pd.DataFrame(results)
    
    tp = ((results_df['true_label'] == 1) & (results_df['predicted_label'] == 1)).sum()
    tn = ((results_df['true_label'] == 0) & (results_df['predicted_label'] == 0)).sum()
    fp = ((results_df['true_label'] == 0) & (results_df['predicted_label'] == 1)).sum()
    fn = ((results_df['true_label'] == 1) & (results_df['predicted_label'] == 0)).sum()
    
    accuracy = (tp + tn) / len(results_df) if len(results_df) > 0 else 0
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0
    
    false_positive_rate = fp / (fp + tn) if (fp + tn) > 0 else 0
    false_negative_rate = fn / (fn + tp) if (fn + tp) > 0 else 0
    
    print("=" * 80)
    print("РЕЗУЛЬТАТЫ НА РЕАЛЬНЫХ ДАННЫХ")
    print("=" * 80)
    print()
    print(f"Всего сообщений: {len(results_df)}")
    print(f"True Positives (TP): {tp} - правильно определен спам")
    print(f"True Negatives (TN): {tn} - правильно определен не спам")
    print(f"False Positives (FP): {fp} - ложно определен как спам")
    print(f"False Negatives (FN): {fn} - пропущен спам")
    print()
    print("=" * 80)
    print("МЕТРИКИ")
    print("=" * 80)
    print(f"Accuracy (Точность): {accuracy:.2%}")
    print(f"Precision (Точность детекции спама): {precision:.2%}")
    print(f"Recall (Полнота детекции спама): {recall:.2%}")
    print(f"F1-Score: {f1:.2%}")
    print()
    print(f"False Positive Rate (FP): {false_positive_rate:.2%}")
    print(f"False Negative Rate (FN): {false_negative_rate:.2%}")
    print()
    
    if fp > 0:
        print("=" * 80)
        print("ПРИМЕРЫ FALSE POSITIVES (блокирует легитимные):")
        print("=" * 80)
        fp_examples = results_df[(results_df['true_label'] == 0) & (results_df['predicted_label'] == 1)]
        for idx, row in fp_examples.head(10).iterrows():
            print(f"\nScore: {row['predicted_score']:.2f}")
            print(f"Text: {row['text']}")
    
    if fn > 0:
        print("\n" + "=" * 80)
        print("ПРИМЕРЫ FALSE NEGATIVES (пропущен спам):")
        print("=" * 80)
        fn_examples = results_df[(results_df['true_label'] == 1) & (results_df['predicted_label'] == 0)]
        for idx, row in fn_examples.head(10).iterrows():
            print(f"\nScore: {row['predicted_score']:.2f}")
            print(f"Text: {row['text']}")
    
    print("\n" + "=" * 80)
    print("ВЫВОД")
    print("=" * 80)
    if false_positive_rate < 0.05:
        print("✅ False Positive Rate < 5% - отлично для продакшена!")
    elif false_positive_rate < 0.10:
        print("⚠️  False Positive Rate < 10% - приемлемо")
    else:
        print("🚨 False Positive Rate > 10% - нужно улучшать!")
    
    if accuracy > 0.80:
        print(f"✅ Accuracy {accuracy:.1%} - хорошая точность")
    elif accuracy > 0.70:
        print(f"⚠️  Accuracy {accuracy:.1%} - приемлемая точность")
    else:
        print(f"🚨 Accuracy {accuracy:.1%} - нужно улучшать")


if __name__ == "__main__":
    asyncio.run(evaluate_on_report())

