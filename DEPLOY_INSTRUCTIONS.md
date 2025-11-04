# Инструкции по деплою TAS на GitHub

## Шаг 1: Создать репозиторий на GitHub

1. Откройте https://github.com/new (уже открыто в браузере)
2. Заполните форму:
   - **Repository name**: `tas`
   - **Description**: `Universal Anti-Spam REST API - Multi-layer spam detection service`
   - **Visibility**: Public (нужно для GitHub Pages)
   - **НЕ выбирайте** "Initialize with README" (у нас уже есть код)
3. Нажмите "Create repository"

## Шаг 2: Push кода

После создания репозитория выполните в терминале:

```bash
cd /Users/nick/myprojects/Cursor/PATAS/tas
git remote add origin https://github.com/kiku-jw/tas.git
git branch -M main
git push -u origin main
```

## Шаг 3: Включить GitHub Pages

1. Перейдите в Settings → Pages (в вашем репозитории)
2. Source: Deploy from a branch
3. Branch: `main` → `/docs` folder
4. Нажмите Save

GitHub Pages автоматически задеплоит демо на https://kiku-jw.github.io/tas/

## Шаг 4: Проверить результаты теста thresholds

После завершения теста (проверьте вывод в терминале), обновите настройки в `app/config.py` если нужно:

```python
rules_threshold: float = 0.7  # Обновить если тест показал лучшее значение
ml_threshold: float = 0.8     # Обновить если тест показал лучшее значение
```

## Шаг 5: Обновить API URL в демо (если нужно)

Если вы задеплоили API на production (например, Render), обновите `docs/index.html`:

```javascript
const API_URL = 'https://your-api-url.onrender.com';
```

## Готово!

Демо будет доступно на: https://kiku-jw.github.io/tas/

