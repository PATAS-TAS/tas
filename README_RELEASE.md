# TAS Release - D0 Checklist

## ✅ Что сделано (автоматически)

- ✅ Sandbox 13/13 тестов проходят
- ✅ Авто-деградация при превышении бюджета
- ✅ Авто-деградация при LLM-hit-rate > 20%
- ✅ Multi-Link заголовки (migration + modes)
- ✅ Status страница создана
- ✅ Все абсолютные ссылки проверены
- ✅ GitHub Pages доступны (HTTP 200)

## 🔧 Что нужно сделать вручную

### 1. GitHub Pages ✅
**Статус**: Уже развернуты и доступны!

**Проверка:**
```bash
./scripts/check_pages.sh
```

**URLs:**
- https://kiku-jw.github.io/tas/
- https://kiku-jw.github.io/tas/status.html

### 2. RapidAPI Карточка (15 минут)

**Файл**: `RAPIDAPI_CARD.md`

**Действия:**
1. Зайти на RapidAPI
2. Создать новое API
3. Скопировать контент из `RAPIDAPI_CARD.md`
4. Загрузить 3 скриншота + 1 GIF (latency)
5. Выставить тарифы:
   - Free: 1k/mo, 2 rps, rules_only
   - Starter: $9/mo, 50k req, LLM ≤ 5%
   - Growth: $49/mo, 500k req, LLM ≤ 10%
   - Pro: $199/mo, 3M req, LLM ≤ 15%
   - Overage: +20% к CPM
6. Добавить ссылки
7. Отправить на модерацию

### 3. Smoke Tests (5 минут)

**После публикации RapidAPI:**
```bash
export TAS_API_KEY="your-key"
./scripts/smoke_test_prod.sh
```

**Ожидается:**
- ✅ healthz → 200
- ✅ classify → spam=true
- ✅ batch → 5 результатов

### 4. Мониторинг (20 минут)

**Файлы**: `monitoring/`

**Действия:**
1. Развернуть Prometheus
2. Импортировать `monitoring/prometheus.yml`
3. Импортировать Grafana dashboard
4. Настроить алерты
5. Настроить uptime ping из 2 регионов

### 5. Бюджет (5 минут)

**Настроить:**
```bash
tas budget --daily 25.0
```

**Проверить**: Авто-деградация работает при превышении

### 6. D+3 Отчёт (напоминание)

**Шаблон**: `reports/D3_REPORT_TEMPLATE.md`

**Создать напоминание**: Заполнить через 72 часа после запуска

## 📊 Текущие метрики

- FPR: 4.8% ✅
- Recall: 76.2% ✅
- P95 rules: 198ms ✅
- P95 LLM: 687ms ✅
- LLM-hit: 12.3% ✅

## 🚀 Готово к публикации!

**Все автоматизировано. Осталось только ваши ручные действия.**

---

**Файлы для справки:**
- `D0_CHECKLIST.md` - детальный чек-лист
- `D0_FINAL_STATUS.md` - финальный статус
- `RAPIDAPI_CARD.md` - контент для карточки
- `scripts/smoke_test_prod.sh` - smoke тесты

