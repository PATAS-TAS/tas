# Документация системы проверки спама

## Основная структура

Проект написан на TypeScript и использует следующие основные компоненты:
- GramJS для взаимодействия с API Telegram
- Express для создания веб-сервера
- OpenAI API для продвинутой классификации сообщений
- Google Cloud Vision API для анализа изображений
- Redis для кэширования результатов

## Процесс проверки спама

### Инициализация и настройка

1. Загрузка конфигурации из переменных окружения
2. Инициализация клиента Telegram
3. Настройка подключения к Redis для кэширования
4. Инициализация Google Cloud Vision для анализа изображений

### Обработка входящих сообщений

- Сообщения от бота добавляются в буфер для проверки
- Системные сообщения с информацией о жалобах обрабатываются отдельно

### Процесс проверки (функция processReport)

Проверки выполняются в следующем порядке с использованием паттерна "Цепочка обязанностей":

1. Проверка кэша (checkCache):
   - Если сообщение найдено в кэше, возвращается сохраненный результат
   - Считается спамом, если в кэше отмечено как спам, и не спамом в противном случае

2. Проверка очевидного спама (checkObvious):
   - Проверяет количество жалоб на сообщения с медиа (спам, если больше 2)
   - Проверяет наличие URL в имени отправителя (спам)
   - Проверяет подозрительные фразы в имени отправителя (спам)
   - Проверяет наличие истории (Stories) (автоматически считается спамом)
   - Проверяет наличие URL-кнопок (спам)
   - Проверяет текст на наличие спам-фраз, коротких спам-фраз, чрезмерное использование эмодзи
   - Проверяет наличие дублирующихся ссылок или рекламных ссылок
   - Проверяет наличие повторяющихся символов
   - Проверяет подозрительные шаблоны сообщений
   - Проверяет наличие избыточной контактной информации
   - Проверяет на дубликаты медиа
   - Проверяет на потенциально вредоносные файлы

3. Проверка GPT (checkGPT):
   - Выполняет предварительную обработку сообщения
   - Проводит глубокую проверку с помощью модели gpt-4-1106-preview
   - Если основная проверка не удалась, выполняет упрощенную проверку с помощью модели gpt-4o-mini
   - Учитывает контекст, количество жалоб, источник, наличие нелегального контента, имя отправителя и наличие ссылок
   - Использует динамический порог для определения спама, учитывая различные факторы

### Препроцессинг и анализ медиа

- Перед проверками выполняется препроцессинг сообщения
- Для медиаконтента выполняется анализ с помощью Google Vision API (если включено)
- Результаты анализа добавляются к preprocessedMessage для дальнейшей обработки

### Условия определения спама

- Высокое количество жалоб (>2 для сообщений с медиа)
- Наличие URL или подозрительных фраз в имени отправителя
- Наличие спам-фраз в тексте сообщения
- Чрезмерное использование определенных эмодзи
- Наличие дублирующихся или рекламных ссылок
- Подозрительные шаблоны сообщений (например, цепочные письма)
- Избыточная контактная информация
- Дублирующиеся медиафайлы или файлы с потенциально вредоносными расширениями
- Высокая оценка вероятности спама от GPT (с динамическим порогом)

### Обработка результатов

- Если сообщение определено как спам, отправляется соответствующий ответ боту
- Результат сохраняется в кэш для будущих проверок
- В случае неоднозначных результатов, сообщение считается не спамом

### Дополнительные функции

- Механизм восстановления для обработки ошибок и зависаний (/undo, "😌 NO", /next)
- Управление сессией бота для оптимизации взаимодействия
- Система кэширования для ускорения повторных проверок
- Анализ медиаконтента с использованием Google Vision API (выполняется на этапе препроцессинга)
- Возможность включения/отключения отдельных проверок через команды администратора
- Настройка задержки между обработкой сообщений
- Автоматический и ручной режимы работы

Этот процесс обеспечивает многоуровневую проверку сообщений на спам, учитывая различные факторы и используя как простые эвристики, так и продвинутые методы анализа с помощью ИИ.



  const gptPrompt = `Analyze multilingual Telegram messages for spam. Prioritize protecting users from scams, unsolicited commercial offers, and genuinely harmful content while allowing normal social interactions. Consider all context provided, but prioritize the actual content of the message. Output JSON only.

Key factors (importance order):
1. Message content and intent (any language)
2. User behavior and message pattern
3. Source relevance and group context
4. Links/media presence and nature
5. Complaint count and Telegram's spam probability (consider context)

Spam indicators (treat these more strictly):
- Any job offers
- Unsolicited commercial offers (e.g., crypto, investments, jobs, adult services)
- Scams, phishing, deceptive practices, get-rich-quick schemes
- Attempts to move conversations to private channels or external links for commercial purposes
- Excessive/shortened URLs unrelated to ongoing discussions
- Repetitive or bot-like behavior across multiple messages
- Unsolicited financial advice or investment opportunities
- Self-promotion for unrelated channels/groups
- Promises of unrealistic profits or returns
- Urgency in financial decisions or investments
- Mentioning specific usernames for financial services
- Explicit sexual content or services
- Invitations for private meetings or services without clear context
- Use of excessive emojis or symbols to bypass text filters
- Messages encouraging users to search for specific terms or usernames
- Promises of easy money or quick returns on investment
- Claims of working alongside studies or current job with minimal effort
- Requests to contact specific usernames for more information about earning opportunities
- Messages in languages different from the group's primary language, especially if promoting financial opportunities

Non-spam indicators:
- Simple greetings or introductions (e.g., "Hi", "Hello", "Good morning")
- Short, neutral messages without suspicious content
- Political discussions or opinions, even if controversial
- Use of strong language or profanity within context of discussion
- Group-relevant content (unless clearly violating community standards)
- Legitimate discussions on current events or social issues
- Standard bot commands/interactions

Weighting:
- Very High: Actual content of the message
- High: User behavior pattern (if known)
- Medium: Group context and complaint count
- Low: Telegram's spam probability for isolated messages

Ambiguous cases:
- For short messages or greetings, prioritize the actual content over group context
- Consider if the message could be a normal social interaction, even in groups with suspicious names
- For political or controversial content, prioritize free speech unless clearly harmful
- Err on the side of caution for explicit invitations or offers, but allow implicit or ambiguous content if not clearly spam

Consider the message content first, then the group context. Be cautious of commercial spam and explicit content, but allow for normal greetings and short social interactions, even in groups with suspicious names.
IMPORTANT: Simple greetings or short, neutral messages should not be classified as spam solely based on the group's name or context. Even in groups with suspicious names, allow for the possibility of normal social interactions unless there's clear evidence of spam behavior. However, be extra vigilant about messages promising easy money or quick returns, especially if they're in a language different from the group's primary language.
`;