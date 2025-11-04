from app.regex_patterns import regex_patterns
from app.config import settings


test_cases = [
    # Normal messages (should be SAFE)
    ("Привет", "SAFE", "Normal greeting"),
    ("Hello", "SAFE", "Normal greeting EN"),
    ("Как дела?", "SAFE", "Normal question"),
    ("Спасибо", "SAFE", "Normal thank you"),
    ("OK", "SAFE", "Short normal"),
    ("Hi there", "SAFE", "Casual greeting"),
    ("Привет, как дела?", "SAFE", "Normal conversation"),
    ("Thanks for your help", "SAFE", "Normal thank you EN"),
    ("See you tomorrow", "SAFE", "Normal farewell"),
    
    # Clear spam (should be SPAM)
    ("Продам iPhone 12, недорого! Звоните +79001234567", "SPAM", "Clear spam with phone"),
    ("Работа на дому! Заработок 50000 руб в день", "SPAM", "Job spam"),
    ("Купить авто в кредит! Звоните сейчас", "SPAM", "Car sale spam"),
    ("Срочно продаю квартиру! Цена 5 млн руб", "SPAM", "Real estate spam"),
    ("Услуги ремонта! Звоните +79001234567", "SPAM", "Service spam"),
    ("Акция! Скидка 50%! Только сегодня!", "SPAM", "Promotion spam"),
    ("Заработок в интернете! Кликните здесь https://scam.com", "SPAM", "Spam with URL"),
    ("Продам, покупаю, обмен! Звоните!", "SPAM", "Multiple commercial keywords"),
    
    # Edge cases (should be carefully balanced)
    ("Продам iPhone", "SPAM", "Short commercial - might be spam"),
    ("Работа", "UNCERTAIN", "Single word - might be spam"),
    ("Купить", "UNCERTAIN", "Single commercial word"),
    ("Звоните", "UNCERTAIN", "Single contact word"),
    ("Привет! Продам iPhone", "SPAM", "Greeting + spam"),
    ("Спасибо за помощь. Работа на дому", "SPAM", "Normal + spam"),
    
    # False positive risks (should be SAFE)
    ("Я работаю программистом", "SAFE", "Job mention but not spam"),
    ("Мы покупаем продукты", "SAFE", "Buy mention but not spam"),
    ("Звоню маме", "SAFE", "Call mention but not spam"),
    ("Продали дом в прошлом году", "SAFE", "Past tense, not offer"),
    ("Ищу работу программистом", "SAFE", "Job search but not spam offer"),
]


def test_rule_balance():
    """Test rule balance and report results."""
    results = {
        "safe_correct": 0,
        "safe_false_negative": 0,
        "spam_correct": 0,
        "spam_false_positive": 0,
        "uncertain": 0,
    }
    
    print("=" * 80)
    print("RULE BALANCE TEST")
    print("=" * 80)
    print()
    
    for text, expected, description in test_cases:
        rule_results = regex_patterns.check(text)
        if rule_results:
            rule_score = max(score for _, score in rule_results)
            if len(rule_results) > 1:
                rule_score = min(rule_score + 0.1 * (len(rule_results) - 1), 0.95)
        else:
            rule_score = 0.0
        
        is_spam = rule_score >= settings.rules_threshold
        actual = "SPAM" if is_spam else "SAFE"
        
        status = "✅"
        if expected == "SAFE" and is_spam:
            status = "❌ FP"
            results["spam_false_positive"] += 1
        elif expected == "SPAM" and not is_spam:
            status = "❌ FN"
            results["safe_false_negative"] += 1
        elif expected == "UNCERTAIN":
            status = "⚠️"
            results["uncertain"] += 1
        elif expected == "SAFE" and not is_spam:
            status = "✅"
            results["safe_correct"] += 1
        elif expected == "SPAM" and is_spam:
            status = "✅"
            results["spam_correct"] += 1
        
        reasons = [r for r, _ in rule_results[:2]] if rule_results else []
        print(f"{status} '{text}'")
        print(f"   Expected: {expected}, Got: {actual} (score: {rule_score:.2f})")
        print(f"   {description}")
        if reasons:
            print(f"   Reasons: {', '.join(reasons)}")
        print()
    
    print("=" * 80)
    print("SUMMARY")
    print("=" * 80)
    total = len(test_cases)
    print(f"Total tests: {total}")
    print(f"✅ Safe correct: {results['safe_correct']}")
    print(f"✅ Spam correct: {results['spam_correct']}")
    print(f"❌ False positives: {results['spam_false_positive']}")
    print(f"❌ False negatives: {results['safe_false_negative']}")
    print(f"⚠️  Uncertain: {results['uncertain']}")
    print()
    
    accuracy = (results['safe_correct'] + results['spam_correct']) / total * 100
    print(f"Accuracy: {accuracy:.1f}%")
    print(f"False Positive Rate: {results['spam_false_positive'] / total * 100:.1f}%")
    print(f"False Negative Rate: {results['safe_false_negative'] / total * 100:.1f}%")
    print()
    print(f"Current rules_threshold: {settings.rules_threshold}")
    print("=" * 80)


if __name__ == "__main__":
    test_rule_balance()

