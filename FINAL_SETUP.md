# Финальная настройка TAS

## Решение: Публичный репозиторий + GitHub Pages + Fly.io

**Рекомендация:** Публичный репозиторий, потому что:
- ✅ Для RapidAPI нужна демонстрация работы
- ✅ GitHub Pages бесплатно и работает только с публичными репо
- ✅ Код API сервиса не содержит секретов (API ключи в env переменных)
- ✅ Профессиональный вид для потенциальных клиентов

## Шаг 1: Создать публичный репозиторий

1. Откройте https://github.com/new (уже открыто)
2. Заполните:
   - **Owner**: kiku-jw
   - **Repository name**: `tas`
   - **Description**: `Universal Anti-Spam REST API - Multi-layer spam detection service`
   - **Visibility**: ✅ **Public**
   - **НЕ выбирайте** "Add a README file" (у нас уже есть)
   - **НЕ выбирайте** ".gitignore" (у нас уже есть)
   - **НЕ выбирайте** "license" (можно добавить позже)
3. Нажмите **"Create repository"**

## Шаг 2: Push кода

После создания репозитория выполните:

```bash
cd /Users/nick/myprojects/Cursor/PATAS/tas
git remote add origin https://github.com/kiku-jw/tas.git
git branch -M main
git push -u origin main
```

## Шаг 3: Настроить GitHub Pages

1. В репозитории перейдите: **Settings** → **Pages**
2. **Source**: Deploy from a branch
3. **Branch**: `main`
4. **Folder**: `/docs`
5. Нажмите **Save**

Демо будет доступно через 1-2 минуты на: **https://kiku-jw.github.io/tas/**

## Шаг 4: Деплой API на Fly.io

### 4.1 Установка Fly CLI

```bash
curl -L https://fly.io/install.sh | sh
```

### 4.2 Логин

```bash
fly auth login
```

### 4.3 Создание приложения

```bash
cd /Users/nick/myprojects/Cursor/PATAS/tas
fly launch --name tas-api --region iad
```

При запросе:
- **App name**: `tas-api` (или оставьте предложенное)
- **Region**: `iad` (или ближайший к вам)
- **Postgres**: Нет (не нужен)
- **Redis**: Нет (не нужен)

### 4.4 Установка секретов

```bash
fly secrets set OPENAI_API_KEY=your_openai_key_here
```

### 4.5 Деплой

```bash
fly deploy
```

API будет доступно на: **https://tas-api.fly.dev**

## Шаг 5: Проверить результаты теста thresholds

После завершения теста (проверьте терминал):

```bash
cd /Users/nick/myprojects/Cursor/PATAS/tas
PYTHONPATH=/Users/nick/myprojects/Cursor/PATAS/tas poetry run python tests/test_thresholds.py
```

Если тест показал оптимальные значения, обновите `app/config.py` и закоммитьте:

```bash
git add app/config.py
git commit -m "Update thresholds based on test results"
git push
```

## Готово! 🎉

- **Демо**: https://kiku-jw.github.io/tas/
- **API**: https://tas-api.fly.dev
- **Репозиторий**: https://github.com/kiku-jw/tas

## Что дальше?

1. Протестировать демо на GitHub Pages
2. Проверить работу API на Fly.io
3. Подготовить документацию для RapidAPI
4. Запустить на RapidAPI marketplace

