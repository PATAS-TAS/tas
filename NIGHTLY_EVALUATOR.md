# Nightly Evaluator - Automated Quality Assessment

Автоматизированная система оценки качества TAS для отслеживания метрик и обнаружения деградации.

## Описание

Nightly Evaluator запускает стратифицированную оценку на выборке из `report.csv`, вычисляет метрики качества (Precision, Recall, F1, FPR, FNR) и производительности (latency), сохраняет результаты в JSON и HTML форматах, а также генерирует графики трендов.

## Использование

### Ручной запуск

```bash
cd tas
poetry run python nightly_evaluator.py \
    --sample 1000 \
    --threshold 0.35 \
    --file ../report.csv
```

### Параметры

- `--sample` - Размер стратифицированной выборки (по умолчанию: 1000)
- `--threshold` - Порог классификации (по умолчанию: 0.35)
- `--seed` - Seed для случайных чисел (по умолчанию: текущее время)
- `--file` - Путь к `report.csv` (по умолчанию: `../report.csv`)
- `--no-plots` - Пропустить генерацию графиков

### Автоматический запуск через Cron

1. Сделайте скрипт исполняемым:
```bash
chmod +x scripts/run_nightly_evaluator.sh
```

2. Добавьте в crontab:
```bash
crontab -e
```

3. Добавьте строку (запуск каждый день в 2:00):
```
0 2 * * * /path/to/tas/scripts/run_nightly_evaluator.sh
```

Для тестирования можно запустить каждые 5 минут:
```
*/5 * * * * /path/to/tas/scripts/run_nightly_evaluator.sh
```

## Результаты

Все результаты сохраняются в директорию `reports/`:

### JSON метрики
- `metrics_YYYYMMDD_HHMMSS.json` - Детальные метрики в JSON формате
- `metrics_latest.json` - Последние метрики (обновляется при каждом запуске)

### HTML отчёты
- `report_YYYYMMDD_HHMMSS.html` - HTML отчёт для инженеров
- `report_latest.html` - Последний отчёт (обновляется при каждом запуске)

### Графики трендов (если matplotlib установлен)
- `trends_metrics.png` - Тренды Precision/Recall/F1
- `trends_fpr.png` - Тренд False Positive Rate
- `trends_latency.png` - Тренд P95 Latency

### Логи
- `nightly_evaluator.log` - Лог выполнения (если используется скрипт)

## Метрики

### Качество детекции
- **Precision** - Точность (цель: >85%)
- **Recall** - Полнота (цель: >70%)
- **F1 Score** - F-мера (цель: >75%)
- **FPR** - False Positive Rate (цель: <5%)
- **FNR** - False Negative Rate
- **Accuracy** - Общая точность

### Производительность
- **Avg Latency** - Средняя задержка
- **P50 Latency** - Медианная задержка
- **P95 Latency** - 95-й перцентиль (цель: <300ms)
- **P99 Latency** - 99-й перцентиль (цель: <700ms)
- **Min/Max Latency** - Минимальная/максимальная задержка

### Конфузионная матрица
- **TP** - True Positives
- **FP** - False Positives
- **TN** - True Negatives
- **FN** - False Negatives

## Отслеживание деградации

Nightly Evaluator загружает историю предыдущих запусков и сравнивает текущие метрики с предыдущими:

- **Тренды** - Изменения метрик со временем
- **Графики** - Визуализация трендов
- **Предупреждения** - Автоматическое обнаружение ухудшения метрик

## Примеры

### Быстрая проверка (100 сообщений)
```bash
poetry run python nightly_evaluator.py --sample 100
```

### Полная оценка (2000 сообщений)
```bash
poetry run python nightly_evaluator.py --sample 2000
```

### Тест с другим порогом
```bash
poetry run python nightly_evaluator.py --threshold 0.4
```

### Без графиков (быстрее)
```bash
poetry run python nightly_evaluator.py --no-plots
```

## Интеграция в CI/CD

Можно интегрировать в GitHub Actions или другие CI/CD системы:

```yaml
# .github/workflows/nightly-eval.yml
name: Nightly Evaluation
on:
  schedule:
    - cron: '0 2 * * *'  # 2 AM UTC
  workflow_dispatch:

jobs:
  evaluate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-python@v4
        with:
          python-version: '3.10'
      - name: Install dependencies
        run: |
          cd tas
          pip install poetry
          poetry install
      - name: Run nightly evaluator
        run: |
          cd tas
          poetry run python nightly_evaluator.py --sample 1000
      - name: Upload reports
        uses: actions/upload-artifact@v3
        with:
          name: evaluation-reports
          path: tas/reports/
```

## Требования

- Python 3.10+
- Poetry для управления зависимостями
- `report.csv` с данными для оценки
- (Опционально) matplotlib для графиков

## Устранение неполадок

### Ошибка: "report.csv not found"
Убедитесь, что файл находится по указанному пути (по умолчанию: `../report.csv`).

### Ошибка: "matplotlib not available"
Графики не будут сгенерированы, но JSON и HTML отчёты будут созданы. Установите matplotlib:
```bash
poetry add --group dev matplotlib
```

### Ошибка: "Not enough history for plots"
Нужно минимум 2 запуска для генерации графиков трендов.

