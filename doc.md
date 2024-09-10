# TAS - Система антиспама для Telegram
## Описание

TAS (Telegram Anti-Spam) - это автоматизированная система для обнаружения спама в группах Telegram. Система использует комбинацию методов, включая кэширование, быструю комплексную проверку и проверку с помощью GPT для принятия решений о спам-сообщениях.

# Процесс работы приложения:

1. Инициализация Telegram, Redis, PostgreSQL, express, OpenAI

2. Отправляем на botId "/next 1"

3. Получаем 2 сообщения:
   а) checkMsg с параметрами `incoming: true, forwards: true`. Для медиа мы записываем тип и хеш медиа (хеш берем из Telegram API)
   б) sysMsg с параметрами `incoming: true, forwards: false, pattern: /Sender:/`. Из этого сообщения мы извлекаем метаданные: reportId: /#r(\d+)/, complaintCount: /😱(\d+)/, source: /^Source:\s*(.+)/m, sender: /^Sender:\s*(.+)/m.

4. Препроцессинг checkMsg: удаляем первые строки

5. Объединяем в один отчет sysMsg и checkMsg. Сохраняем в Redis.

6. Проверяем отчет:
   а) checkCache - Ищем в кеше идентичные messageContent и mediaHashes с теми что в отчете checkMsg. Если обнаружены, отправляем такой же decision как в isSpam в кеше. Если не обнаружено, проверяем дальше:
   б) fastCheck - Быстрая проверка: если в checkMsg есть ссылки, @юзернеймы и медиа с больше 2 жалобами - это спам; или если там есть тип медиа истории, URL кнопки - это спам. Если обнаружен спам, отправляем сразу decision спам. Если нет, проверяем дальше:
   в) gptCheck - Проверка с помощью GPT - проверяем checkMsg, используя данные из sysMsg как контекст.

## Важные моменты:
- Отправляя decision, мы сохраняем его в кеше в строке отчета в столбе isSpam: 1-спам, 0-не спам.
- После сохранения отчета в Redis, от туда отчеты пакетно сохраняются в PostgreSQL.
- Сохранение отчетов в PostgreSQL с партиционированием по дате
- Перед отправкой команд и decision должна быть задержка 100 мс.
- В случае ошибок или если ни одна из проверок не дала результата в течении 30 секунд, сбрасываем процесс проверки и отправляем "/undo". Этот таймер сбрасывается если обработка успешна.

# Подробности реализации
## Основные компоненты
- Telegram Client (использует библиотеку telegram gramJS)
- Redis Cache (использует ioredis на Heroku)
- PostgreSQL Database (использует pg на Heroku)
- Express Server (для API и мониторинга)
- OpenAI API Client (для GPT проверок)

## Команды администратора

- "/start" - активация автоматического режима
- "/stop" - остановка работы приложения и переход в ручной режим
- "/status" - получение текущего статуса бота
- "/time [value]" - установка задержки между командами (в миллисекундах)
- "/reset" - очистка кэша Redis
- "/db" - выполнение операций с базой данных и генерация отчета

## Конфигурация и переменные окружения

```typescript
// env:
const BOT_ID: string; 
const PORT: number = 3000;
const API_HASH: string;
const ADMIN_ID: string;
const REDIS_URL: string;
const DATABASE_URL: string;
const API_ID: number;
const DEEP_LOG: boolean;
const SESSION_STRING: string;
const OPENAI_API_KEY: string;
const BOT_ACCESS_HASH: string;

// обычные переменные:
const COMMAND_DELAY: number = 1000;
const MAX_CACHE_SIZE: number = 10000;
const DB_SCHEMA_VERSION: string = '1.0';
const MEDIA_EXPIRY: number = 600; // 10 minutes
const ENABLE_GPT_MEDIA_ANALYSIS: boolean = true;
const BUFFER_DELAY: number = 100; // 100 ms
const MAX_PROCESSING_TIME: number = 30000; // 30 seconds
```

## Регулярные выражения
```typescript
const sysRegex = {
  reportId: /#r(\d+)/,
  complaintCount: /😱(\d+)/,
  source: /^(?:🗣\s*)?Source:\s*(.+)/m,
  sender: /^Sender:\s*(.+)/m,
};
```

## Типы сообщений и их обработчики

1. **checkMsg** (сообщения для классификации)
   - Параметры: `incoming: true, forwards: true`
   - Обработчик: `handleCheck()`
   
   Цель: Обработка пересланных сообщений от бота для анализа на предмет спама.

2. **sysMsg** (системные сообщения)
   - Параметры: `incoming: true, forwards: false, pattern: /Sender:/` (и анти паттерн "Admin:")
   - Обработчик: `handleSys()`
   
   Цель: Обработка системных сообщений, содержащих метаданные отчета.

3. **addMsg** (дополнительные сообщения)
   - Параметры: `incoming: true, forwards: false`
   - Обработчик: `handleAdd()`
   
   Цель: Обработка различных служебных сообщений от бота.

4. **adminMsg** (сообщения от администратора)
   - Параметры: `incoming: true, forwards: false, fromUsers: [ADMIN_ID]`
   - Обработчик: `handleAdmin()`
   
   Цель: Обработка команд администратора для управления системой.

## Основные функции

1. `processBuffer()`: Обрабатывает буфер сообщений, создавая отчеты из сгруппированных сообщений.

2. `processReport()`: Координирует процесс проверки отчета на спам, используя различные методы.

3. `fastCheck()`: Выполняет быструю проверку на наличие явных признаков спама.

4. `gptCheck()`: Использует GPT для анализа сложных случаев спама.

5. `applyDecision()`: Применяет решение о спаме и обновляет отчет.

6. `saveCache()`: Сохраняет отчет в кэше Redis.

7. `checkCache()`: Проверяет наличие решения в кэше для данного отчета.

8. `downloadAndStoreMedia()`: Загружает и сохраняет медиафайлы для анализа GPT.

9. `saveRedisToPostgres()`: Переносит данные из Redis в PostgreSQL.

10. `generateCsvReport()`: Создает CSV-отчет о спам-активности.

## Дополнительные функции

1. `checkSystemHealth()`: Проверяет состояние всех компонентов системы.

2. `cleanupOldData()`: Удаляет устаревшие данные из Redis и PostgreSQL.

3. `gracefulShutdown()`: Обеспечивает корректное завершение работы приложения.

4. `limitCacheSize()`: Ограничивает размер кэша Redis.

Эта документация отражает текущее состояние кода, включая обновленные функции и процессы.