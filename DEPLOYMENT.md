# Deployment Guide

## GitHub Pages (Demo)

**Плюсы:**
- Бесплатно
- Автоматический деплой
- HTTPS из коробки
- Хорошо для статического демо

**Минусы:**
- Только статический контент (HTML/JS)
- API должен быть на другом сервере

### Настройка

1. Репозиторий должен быть **публичным**
2. Settings → Pages → Source: `main` branch → `/docs` folder
3. Демо будет доступно на: `https://kiku-jw.github.io/tas/`

## Fly.io (API Backend)

**Плюсы:**
- Бесплатный tier (3 shared-cpu VMs)
- Автоматический деплой
- HTTPS из коробки
- Быстрый старт

**Минусы:**
- Нужна регистрация
- Ограничения на бесплатном tier

### Настройка

1. Установите Fly CLI:
```bash
curl -L https://fly.io/install.sh | sh
```

2. Логин:
```bash
fly auth login
```

3. Деплой:
```bash
cd tas
fly launch --name tas-api
```

4. Установите переменные окружения:
```bash
fly secrets set OPENAI_API_KEY=your_key_here
```

5. Обновите URL в `docs/index.html`:
```javascript
const API_URL = 'https://tas-api.fly.dev';
```

## Render.com (Альтернатива)

**Плюсы:**
- Бесплатный tier
- Простой деплой из GitHub
- Автоматический HTTPS

### Настройка

1. Создайте новый Web Service на Render
2. Подключите GitHub репозиторий
3. Build Command: `poetry install && poetry run uvicorn app.main:app --host 0.0.0.0 --port $PORT`
4. Start Command: `poetry run uvicorn app.main:app --host 0.0.0.0 --port $PORT`
5. Добавьте переменные окружения в Dashboard

## Рекомендация

Для RapidAPI лучше всего:
- **GitHub**: Публичный репозиторий + Pages (демо)
- **Fly.io**: API backend (быстрый, бесплатный tier)

Или:
- **GitHub**: Публичный репозиторий + Pages (демо)
- **Render.com**: API backend (проще для начинающих)

