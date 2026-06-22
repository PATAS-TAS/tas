# Feedback System - Production Feedback Loop

Система обратной связи для сбора FP/FN примеров из продакшена и обучения правил на живых данных.

## Описание

Feedback System позволяет продакшен-системам сообщать о ложных срабатываниях (False Positives) и пропущенных спаме (False Negatives). Эти данные сохраняются в базе данных и используются для:

- **Анализа производительности правил** - какие правила дают больше FP/FN
- **Генерации отчётов** - детальная статистика по каждому правилу
- **Обучения правил** - улучшение паттернов на основе реальных данных

## API Endpoints

### POST `/feedback`

Отправить feedback о FP/FN примере.

**Request:**
```json
{
  "text": "Продам дом в прошлом году",
  "predicted_spam": true,
  "actual_spam": false,
  "sender_id": "user123",
  "message_id": "msg456",
  "lang": "ru",
  "metadata": {
    "source": "telegram",
    "channel": "general"
  }
}
```

**Response:**
```json
{
  "status": "recorded",
  "feedback_id": 1,
  "error_type": "FP",
  "message": "FP feedback recorded successfully"
}
```

**Параметры:**
- `text` (required) - Текст сообщения
- `predicted_spam` (required) - Что предсказал TAS (true/false)
- `actual_spam` (required) - Что на самом деле (true/false)
- `sender_id` (optional) - ID отправителя
- `message_id` (optional) - ID сообщения
- `lang` (optional) - Язык сообщения
- `metadata` (optional) - Дополнительные метаданные (JSON object)

### GET `/feedback/report`

Получить отчёт по производительности правил.

**Query параметры:**
- `format` (optional) - Формат отчёта: `json` (default) или `html`

**Пример запроса:**
```bash
curl http://localhost:8000/feedback/report?format=json
```

**JSON Response:**
```json
{
  "summary": {
    "total_feedback": 150,
    "false_positives": 45,
    "false_negatives": 23,
    "unique_rules": 18
  },
  "per_rule": {
    "Commercial trade offer": {
      "total_matches": 120,
      "false_positives": 15,
      "false_negatives": 5,
      "true_positives": 95,
      "true_negatives": 5,
      "precision": 0.8636,
      "recall": 0.9500,
      "f1_score": 0.9048,
      "false_positive_rate": 0.1250,
      "last_updated": "2025-01-15T10:30:00Z"
    }
  },
  "recommendations": [
    "Rule 'Job offer or work solicitation' has high FPR (15.2%) with 8 FPs. Consider refining the pattern or adding negative context checks."
  ]
}
```

**HTML отчёт:**
```bash
curl http://localhost:8000/feedback/report?format=html
```

HTML отчёт сохраняется в `reports/feedback_report_YYYYMMDD_HHMMSS.html` и `reports/feedback_report_latest.html`.

### GET `/feedback/entries`

Получить список feedback записей.

**Query параметры:**
- `error_type` (optional) - Фильтр: `fp` или `fn`
- `limit` (optional) - Максимум записей (default: 100, max: 1000)
- `offset` (optional) - Смещение для пагинации (default: 0)

**Пример:**
```bash
curl "http://localhost:8000/feedback/entries?error_type=fp&limit=50"
```

**Response:**
```json
{
  "entries": [
    {
      "id": 1,
      "timestamp": "2025-01-15T10:30:00Z",
      "text": "Продам дом в прошлом году",
      "predicted_spam": true,
      "actual_spam": false,
      "error_type": "fp",
      "spam_score": 0.45,
      "confidence": 0.45,
      "reasons": ["Commercial trade offer"],
      "matched_rules": ["Commercial trade offer"],
      "sender_id": "user123",
      "message_id": "msg456",
      "lang": "ru",
      "metadata": {}
    }
  ],
  "count": 1,
  "limit": 50,
  "offset": 0
}
```

## Использование

### Интеграция в продакшен

```python
import requests

# После получения классификации от TAS
tas_response = requests.post(
    "https://tas.fly.dev/classify",
    json={"text": message_text, "lang": "ru"}
).json()

# Если пользователь сообщил об ошибке (FP или FN)
if user_reported_error:
    feedback_response = requests.post(
        "https://tas.fly.dev/feedback",
        json={
            "text": message_text,
            "predicted_spam": tas_response["is_spam"],
            "actual_spam": not tas_response["is_spam"],  # Противоположное
            "sender_id": user_id,
            "message_id": message_id,
            "lang": "ru",
            "metadata": {
                "source": "telegram",
                "user_action": "report_spam" if tas_response["is_spam"] else "report_not_spam"
            }
        }
    )
```

### Генерация отчётов

#### Через API:
```bash
# JSON отчёт
curl http://localhost:8000/feedback/report?format=json > feedback_report.json

# HTML отчёт
curl http://localhost:8000/feedback/report?format=html
```

#### Программно:
```python
from app.feedback_reporter import generate_html_report, generate_rule_report

# Генерация JSON отчёта
json_report = generate_rule_report()
print(f"Report saved to: {json_report}")

# Генерация HTML отчёта
html_report = generate_html_report()
print(f"Report saved to: {html_report}")
```

## База данных

Feedback хранится в SQLite базе данных `feedback.db`:

### Таблицы

#### `feedback`
Хранит отдельные записи feedback:
- `id` - Уникальный ID
- `timestamp` - Время создания
- `text` - Текст сообщения
- `predicted_spam` - Предсказание TAS
- `actual_spam` - Реальная метка
- `error_type` - `fp` или `fn`
- `spam_score` - Score от TAS
- `confidence` - Confidence от TAS
- `reasons` - JSON массив причин
- `matched_rules` - JSON массив сработавших правил
- `sender_id`, `message_id`, `lang` - Метаданные
- `metadata` - Дополнительные данные (JSON)

#### `rule_stats`
Агрегированная статистика по правилам:
- `rule_name` - Название правила
- `total_matches` - Всего срабатываний
- `false_positives` - Ложные срабатывания
- `false_negatives` - Пропущенный спам
- `true_positives` - Правильные срабатывания
- `true_negatives` - Правильные пропуски
- `last_updated` - Время последнего обновления

## Отчёты

### JSON отчёт

Содержит:
- Сводную статистику (total_feedback, FP, FN, unique_rules)
- Детальную статистику по каждому правилу:
  - Precision, Recall, F1, FPR
  - Количество TP, FP, TN, FN
- Примеры FP/FN (первые 10)
- Рекомендации по улучшению правил

### HTML отчёт

Визуальный отчёт для инженеров:
- Сводные карточки метрик
- Таблица производительности правил
- Цветовая индикация проблем:
  - 🔴 Красный - Критичные проблемы (FPR > 20%, много FN)
  - 🟡 Жёлтый - Предупреждения (FPR > 10%, средние FN)
  - 🟢 Зелёный - Всё в порядке

## Обучение правил на основе feedback

### Анализ проблемных правил

1. **Высокий FPR (>10%)**:
   - Уточнить паттерн (сделать более специфичным)
   - Добавить отрицательные контексты (negative lookahead)
   - Снизить score для этого правила

2. **Высокий FN (>10)**:
   - Расширить паттерн (добавить варианты)
   - Добавить новые ключевые слова
   - Повысить score для этого правила

3. **Низкая Precision (<70%)**:
   - Сделать паттерн более специфичным
   - Добавить проверки контекста

4. **Низкая Recall (<50%)**:
   - Расширить паттерн
   - Добавить синонимы и варианты написания

### Пример улучшения правила

**До:**
```python
(re.compile(r"(?i)\b(?:продам|продаю)\b"), "Commercial trade offer", 0.4)
```

**Проблема:** Высокий FPR (15%) из-за фраз типа "продам дом в прошлом году"

**После:**
```python
(re.compile(
    r"(?i)\b(?:продам|продаю)\b(?![^\s]*\b(?:в\s+прошлом|в\s+прошлом\s+году))\b"
), "Commercial trade offer", 0.4)
```

Добавлен negative lookahead для исключения исторических контекстов.

## Автоматизация

### Регулярная генерация отчётов

Добавьте в cron или scheduled task:

```bash
# Генерация отчёта каждую ночь в 3:00
0 3 * * * curl http://localhost:8000/feedback/report?format=html
```

Или через Python:

```python
# scripts/generate_feedback_report.py
from app.feedback_reporter import generate_html_report, generate_rule_report

if __name__ == "__main__":
    json_report = generate_rule_report()
    html_report = generate_html_report()
    print(f"Reports generated: {json_report}, {html_report}")
```

## Мониторинг

### Ключевые метрики для отслеживания:

1. **Total Feedback** - Общее количество feedback записей
2. **FP Rate** - Процент ложных срабатываний от всех feedback
3. **FN Rate** - Процент пропущенного спама
4. **Rules with High FPR** - Правила с FPR > 10%
5. **Rules with High FN** - Правила с > 10 FN

### Алерты

Настройте алерты на:
- FPR > 15% для любого правила
- > 20 FN для любого правила за последние 7 дней
- Резкий рост FP/FN rate (например, > 50% за неделю)

## Примеры использования

### Telegram Bot интеграция

```python
from telegram import Update
from telegram.ext import ContextTypes
import requests

async def handle_spam_report(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик сообщения пользователя о неправильной классификации."""
    message = update.message.reply_to_message
    
    # Отправить feedback в TAS
    requests.post(
        "https://tas.fly.dev/feedback",
        json={
            "text": message.text,
            "predicted_spam": True,  # TAS пометил как спам
            "actual_spam": False,  # Пользователь сообщает, что это не спам
            "sender_id": str(message.from_user.id),
            "message_id": str(message.message_id),
            "metadata": {
                "source": "telegram",
                "reported_by": str(update.effective_user.id)
            }
        }
    )
    
    await update.message.reply_text("Спасибо за обратную связь! Мы учтём это.")
```

### Автоматический сбор через модерацию

```python
# После модерации сообщения
def on_moderation_result(message_text, tas_result, moderator_result):
    if tas_result["is_spam"] != moderator_result["is_spam"]:
        # Несоответствие - отправляем feedback
        requests.post(
            "https://tas.fly.dev/feedback",
            json={
                "text": message_text,
                "predicted_spam": tas_result["is_spam"],
                "actual_spam": moderator_result["is_spam"],
                "metadata": {
                    "source": "moderation",
                    "moderator_id": moderator_result["moderator_id"]
                }
            }
        )
```

## Troubleshooting

### База данных не создаётся

Убедитесь, что директория доступна для записи:
```bash
ls -la feedback.db
chmod 664 feedback.db
```

### Ошибка "Feedback database not found"

База данных создаётся автоматически при первом использовании. Убедитесь, что:
- У процесса есть права на запись в директорию
- Достаточно места на диске

### Отчёты не генерируются

Проверьте:
- Существуют ли записи в базе данных
- Доступна ли директория `reports/` для записи
- Логи ошибок в консоли

