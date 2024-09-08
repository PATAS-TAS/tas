# TAS - Система антиспама для Telegram
## Описание

TAS (Telegram Anti-Spam) - это автоматизированная система для обнаружения спама в группах Telegram. Система использует комбинацию методов, включая кэширование, быструю комплексную проверку, анализ мнений модераторов и проверку с помощью GPT для принятия решений о спам-сообщениях.

# Процесс работы приложения:

1. Инициализация Telegram, Redis, PostgreSQL, express, OpenAI

2. Отправляем на botId "/next 1"

3. Получаем 2 сообщения:
   а) checkMsg с параметрами `incoming: true, forwards: true`. Для медиа мы записываем тип и хеш медиа (хеш берем из Telegram API)
   б) sysMsg с параметрами `incoming: true, forwards: false, pattern: /Sender:/` (и анти паттерн "Admin:"). Из этого сообщения мы извлекаем метаданные: reportId: /#r(\d+)/, complaintCount: /😱(\d+)/, source: /^Source:\s*(.+)/m, sender: /^Sender:\s*(.+)/m.

4. Препроцессинг checkMsg: удаляем первые строки

5. Объединяем в один отчет sysMsg с теми checkMsg, которые пришли в течении 100 миллисекунд вместе с sysMsg (или перед ним). Сохраняем в Redis.

6. Проверяем отчет:
   а) checkCache - Ищем в кеше идентичные messageContent и mediaHashes с теми что в отчете checkMsg. Если обнаружены, отправляем такой же decision как в isSpam в кеше. Если не обнаружено, проверяем дальше:
   б) fastCheck - Быстрая проверка: если в checkMsg есть ссылки, @юзернеймы и медиа с больше 2 жалобами - это спам; или если там есть тип медиа истории, URL кнопки - это спам. Если обнаружен спам, отправляем сразу decision спам. Если нет, проверяем дальше:
   в) modCheck - Проверка модераторов выполняется один раз на reportId: 
      - Отправляем /stats и ждём addMsg с includes фразой "Total this month:". 
      - Отправляем reportId отчета и ждём modMsg с includes фразой "Admin:". 
      - Если в этом сообщении также есть слово "— Flood", значит это спам. Если есть слово "— Not Spam" значит это не спам. 
      - Если есть оба эти слова или ни одного, значит пропускаем проверку мнения модераторов и передаем следующей проверке. 
      - Принимая решение в проверке мнений модераторов, мы не отправляем decision, а просто сохраняем решение isSpam в кеше. 
      - После этого мы отправляем botId сообщение "/next 2" и выходим из цикла проверки отчета.
   г) gptCheck - Проверка с помощью GPT - проверяем checkMsg, используя данные из sysMsg как контекст.

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

```
## Регулярные выражения
```typescript

const sysRegex = {
  reportId: /#r(\d+)/,
  complaintCount: /😱(\d+)/,
  source: /^(?:🗣\s*)?Source:\s*(.+)/m,
  sender: /^Sender:\s*(.+)/m,
  admin: /^Admin:\s*(.+)/m,
  modFlood: /– Flood/,
  modNotSpam: /– Not Spam/
};
```

## Типы сообщений и их обработчики

1. **checkMsg** (сообщения для классификации)
   - Параметры: `incoming: true, forwards: true`
   - Обработчик: `handleCheck()`
   
   Цель: Обработка пересланных сообщений от бота для анализа на предмет спама.
   
   ```typescript
   async function handleCheck(event: NewMessageEvent): Promise<void> {
     // Проверка режима работы
     // Извлечение и предобработка сообщений (удаление первой строки)
     // Добавление сообщения и медиа в буфер
     // Планирование обработки буфера
   }
   ```

2. **sysMsg** (системные сообщения)
   - Параметры: `incoming: true, forwards: false, pattern: /Sender:/` (и анти паттерн "Admin:")
   - Обработчик: `handleSys()`
   
   Цель: Обработка системных сообщений, содержащих метаданные отчета.
   
   ```typescript
   async function handleSys(event: NewMessageEvent): Promise<void> {
     // Извлечение информации об отчете
     // Добавление системного сообщения в буфер
     // Планирование обработки буфера
   }
   ```

3. **modMsg** (сообщения модераторов)
   - Параметры: `incoming: true, forwards: false, pattern: /Admin:/`
   - Обработчик: `handleMod()`
   
   Цель: Обработка сообщений от модераторов с их мнением о спаме.
   
   ```typescript
   async function handleMod(event: NewMessageEvent): Promise<void> {
     // Извлечение мнения модератора "– Flood" и "– Not Spam"
   }
   ```

4. **addMsg** (дополнительные сообщения)
   - Параметры: `incoming: true, forwards: false`
   - Обработчик: `handleAddMsg()`
   
   Цель: Обработка различных служебных сообщений от бота.
   
   ```typescript
   async function handleAddMsg(event: NewMessageEvent): Promise<void> {
  // - Типы сообщений и реакции:
  //  - "Hello there! Send /next to start processing reports." -> "/next 6"
  //  - "No Reports Found" -> выполнение функции undo()
  //  - "Please select 😡 BAN or 😌 NO." -> выполнение функции undo()
  // - "Sorry, an error has occurred during your request. Please try again later." -> выполнение функции undo()
  // - "Total this month:" - используется в проверке модераторов
   }
   ```

   ## Проверка модераторов (modCheck)
1. Анализ количества мнений "Flood" и "Not Spam"
2. Принятие решения на основе следующих правил:
   - 2 или более "Flood" -> Спам (100% уверенность)
   - 2 или более "Not Spam" -> Не спам (100% уверенность)
   - 1 "Flood" и 0 "Not Spam" -> Спам (90% уверенность)
   - 1 "Not Spam" и 0 "Flood" -> Не спам (90% уверенность)
   - Другие комбинации -> null