# Быстрая настройка - все команды

## 1. Создать репозиторий на GitHub

В браузере (уже открыто): https://github.com/new

- Repository name: `tas`
- Description: `Universal Anti-Spam REST API - Multi-layer spam detection service`
- ✅ **Public** (для GitHub Pages)
- НЕ добавляйте README, .gitignore, license

## 2. Push кода

```bash
cd /Users/nick/myprojects/Cursor/PATAS/tas
git remote add origin https://github.com/kiku-jw/tas.git
git branch -M main
git push -u origin main
```

## 3. Включить GitHub Pages

1. Settings → Pages
2. Source: `main` → `/docs`
3. Save

## 4. Деплой на Fly.io

```bash
# Установка CLI (если еще не установлен)
curl -L https://fly.io/install.sh | sh

# Логин
fly auth login

# Создание приложения
cd /Users/nick/myprojects/Cursor/PATAS/tas
fly launch --name tas-api --region iad

# Установка секретов
fly secrets set OPENAI_API_KEY=your_key_here

# Деплой
fly deploy
```

## Готово!

- Демо: https://kiku-jw.github.io/tas/
- API: https://tas-api.fly.dev

