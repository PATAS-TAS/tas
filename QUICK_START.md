# Быстрый старт - TAS на GitHub

## 1. Создать репозиторий (в браузере)

Форма уже открыта. Заполните:
- Repository name: `tas`
- Description: `Universal Anti-Spam REST API - Multi-layer spam detection service`
- Public (для GitHub Pages)
- НЕ выбирайте "Initialize with README"

## 2. Push кода (в терминале)

```bash
cd /Users/nick/myprojects/Cursor/PATAS/tas
git remote add origin https://github.com/kiku-jw/tas.git
git branch -M main
git push -u origin main
```

## 3. Включить GitHub Pages

1. Settings → Pages
2. Source: `main` branch → `/docs` folder
3. Save

## 4. Проверить тест thresholds

После завершения теста (может занять несколько минут):
```bash
cd /Users/nick/myprojects/Cursor/PATAS/tas
PYTHONPATH=/Users/nick/myprojects/Cursor/PATAS/tas poetry run python tests/test_thresholds.py
```

Если тест показал другие оптимальные значения, обновите `app/config.py`:
```python
rules_threshold: float = 0.7  # Заменить на оптимальное значение
ml_threshold: float = 0.8    # Заменить на оптимальное значение
```

Затем:
```bash
git add app/config.py
git commit -m "Update thresholds based on test results"
git push
```

## 5. Демо доступно

https://kiku-jw.github.io/tas/

