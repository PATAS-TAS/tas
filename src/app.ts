// app.ts

// Импорт необходимых модулей и типов
import { NewMessage, NewMessageEvent } from 'telegram/events/NewMessage.js';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { StringSession } from 'telegram/sessions/index.js';
import { TelegramClient } from 'telegram/index.js';
import { Api } from 'telegram/tl/index.js';
import { promises as fs } from 'fs';
import { Mutex } from './mutex.js';
import { Redis } from 'ioredis';
import express from 'express';
import prompts from 'prompts';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import {
  spamPhrases,
  shortSpamPhrases,
  adKeywordsAndDomains,
  urlShorteners,
  dangerousExtensions,
  spamEmojis,
  urlRegex,
  suspiciousPhrases
} from './keywords.js';

// Загрузка переменных окружения из файла .env
dotenv.config();

// КОНФИГУРАЦИЯ
//--------------------------------------------------

// Инициализация Express приложения
const app = express();

// Создание мьютекса для синхронизации обработки сообщений
const processingMutex = new Mutex();

// Порт для запуска сервера (по умолчанию 3000)
const port = process.env.PORT || 3000;

// API хэш для Telegram API
const apiHash = process.env.API_HASH!;

// Номер телефона для авторизации в Telegram
const phoneNumber = process.env.PHONE_NUMBER!;

// API ID для Telegram API
const apiId = parseInt(process.env.API_ID!);

// ID бота, с которым взаимодействует система
const botId = parseInt(process.env.BOT_ID!);

// ID администратора системы
const adminId = parseInt(process.env.ADMIN_ID!);

// Инициализация клиента OpenAI API
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Время жизни кэша в секундах (по умолчанию 1 день)
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '86400', 10);

// Инициализация клиента Google Cloud Vision API
const visionClient = new ImageAnnotatorClient({projectId: process.env.GOOGLE_CLOUD_PROJECT,});

// Максимальный размер файла для анализа (5 МБ)
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// Размер пула соединений Redis
const REDIS_POOL_SIZE = 5;

// Максимальное использование кэша (90%)
const MAX_CACHE_USAGE = 0.9;

// Максимальное время обработки сообщения (59 секунд)
const MAX_PROCESSING_TIME = 59 * 1000;

// Таймаут для проверки наличия новых сообщений (55 секунд)
const CHECK_MSG_TIMEOUT = 55000;

// Глобальные переменные для управления состоянием системы
let recoveryTimer: NodeJS.Timeout | null = null;
let nextTimer: NodeJS.Timeout | null = null;
let client: TelegramClient;
let processInterval = 100;
let isAutoMode = true; // переключатель авто режима
let isProcessing = false;
let isVisionEnabled = true; // переключатель анализа медиа
let enabledChecks = new Set(['cache', 'obvious', 'gpt']); // список включенных проверок
let processingStartTime: number | null = null;
let lastCheckMsgTime = Date.now();
let checkMsgTimeoutTimer: NodeJS.Timeout | null = null;

// ИНТЕРФЕЙСЫ
//--------------------------------------------------

// Интерфейс для информации о проверке
interface CheckInfo {
  messages: Api.Message[];
  storyCaption?: string;
}

// Интерфейс для системной информации о сообщении
interface SysInfo {
  hasLink: string;
  reportId: string;
  complaintCount: number;
  source: string;
  sender: string;
  crowdOpinions: string[];
  telegramSpamProbability: number;
}

// Интерфейс для результата проверки
interface ResultInfo {
  isSpam: boolean | undefined;
  layer: number;
  reason: string;
  visionResults?: VisionResult[];
  illegalContentDetected?: boolean;
  combinedMessage?: string;  
}

// Интерфейс для записи в кэше
interface CacheEntry {
  message?: string;
  mediaHash?: string;
  mediaType?: string;
  timestamp: number;
  gptScore?: number;
  response: string;
}

// Интерфейс для буфера отчетов
interface ReportBuffer {
  messages: Api.Message[];
  sysInfo: SysInfo | null;
  lastUpdateTime: number;
}

// Интерфейс для результата анализа изображения
interface VisionResult {
  type: string;
  labels: string[];
  safeSearch: any;
  textAnnotations?: { description: string }[];
}

// Тип для результата проверки
type CheckResult = ResultInfo | null;

// Интерфейс для функции проверки
interface CheckFunction {
  (messages: Api.Message[], sysInfo: SysInfo): Promise<CheckResult>;
}

// КЛАССЫ ПРОВЕРКИ СПАМА
//--------------------------------------------------

// Абстрактный класс для проверки спама
abstract class SpamChecker {
  protected next: SpamChecker | null = null;

  // Метод для установки следующего проверяющего в цепочке
  setNext(checker: SpamChecker): SpamChecker {
    this.next = checker;
    return checker;
  }

  // Абстрактный метод проверки, который должен быть реализован в подклассах
  abstract check(messages: Api.Message[], sysInfo: SysInfo): Promise<CheckResult>;

  // Метод для обработки проверки и передачи результата следующему проверяющему
  async handleCheck(messages: Api.Message[], sysInfo: SysInfo): Promise<CheckResult | null> {
    const result = await this.check(messages, sysInfo);
    if (result) {
      return result;
    }
    if (this.next) {
      return this.next.handleCheck(messages, sysInfo);
    }
    return null;
  }
}

// Класс для проверки кэша
class CacheChecker extends SpamChecker {
  async check(messages: Api.Message[]): Promise<CheckResult> {
    return checkCache(messages);
  }
}

// Класс для проверки очевидного спама
class ObviousChecker extends SpamChecker {
  check: CheckFunction = async (messages, sysInfo) => {
    return checkObvious(messages, sysInfo);
  }
}

// Класс для проверки с использованием GPT
class GPTChecker extends SpamChecker {
  check: CheckFunction = async (messages, sysInfo) => {
    const { preprocessedMessage, visionResults, isSpam } = await preprocessAndAnalyze(messages);
    return checkGPT(messages, sysInfo, preprocessedMessage, visionResults, isSpam);
  }
}

// Создание цепочки проверок
const cacheChecker = new CacheChecker();
const obviousChecker = new ObviousChecker();
const gptChecker = new GPTChecker();

cacheChecker
  .setNext(obviousChecker)
  .setNext(gptChecker);

// ИНИЦИАЛИЗАЦИЯ КЛИЕНТА
//--------------------------------------------------

// Функция для инициализации клиента Telegram
async function initClient(): Promise<TelegramClient> {
  // Получение строки сессии из переменных окружения
  const sessionString = process.env.SESSION_STRING || "";
  const stringSession = new StringSession(sessionString);
  
  // Создание клиента Telegram
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  // Если строка сессии отсутствует, запускаем процесс авторизации
  if (!sessionString) {
    await client.start({
      phoneNumber: async () => phoneNumber,
      password: async () => await promptInput('Password'),
      phoneCode: async () => await promptInput('Phone code'),
      onError: (err) => console.log(err),
    });

    // Сохранение новой строки сессии
    const newSessionString = stringSession.save();
    console.log("New session string:", newSessionString);
    console.log("Please set this as SESSION_STRING in your .env file");
    
    try {
      // Обновление файла .env с новой строкой сессии
      await updateEnvFile("SESSION_STRING", newSessionString);
      console.log("SESSION_STRING has been updated in .env file");
    } catch (error) {
      console.error("Failed to update .env file. Please set SESSION_STRING manually.");
    }
  } else {
    // Если строка сессии существует, просто подключаемся
    await client.connect();
  }
  return client;
}

// Функция для обновления файла .env
async function updateEnvFile(key: string, value: string): Promise<void> {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    let envContent = await fs.readFile(envPath, 'utf-8');
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (envContent.match(regex)) {
      envContent = envContent.replace(regex, `${key}="${value}"`);
    } else {
      envContent += `\n${key}="${value}"`;
    }
    await fs.writeFile(envPath, envContent, 'utf-8');
    console.log(`Updated .env file: ${key} has been set.`);
  } catch (error) {
    console.error('Error updating .env file:', error);
    throw error;
  }
}

// Функция для запроса ввода от пользователя
async function promptInput(inputType: string, isPassword: boolean = false): Promise<string> {
  const response = await prompts({
    type: isPassword ? 'password' : 'text',
    name: 'value',
    message: `Please enter your ${inputType}:`,
    validate: (value) => value.length > 0 || `Please enter a valid ${inputType}`
  });
  return response.value;
}

// ФУНКЦИИ АДМИНИСТРАТОРА
//--------------------------------------------------

// Функция для уведомления администратора
async function notifyAdmin(message: string, error?: any): Promise<void> {
  try {
    let fullMessage = `TAS: ${message}`;
    if (error) fullMessage += `\n\nError details: ${error.message || error}`;
    await client.sendMessage(adminId, { message: fullMessage });
  } catch (notifyError) {
    console.error('Error notifying admin:', notifyError);
  }
}

// Функция для обработки сообщений от администратора
async function adminMsg(event: NewMessageEvent): Promise<void> {
  const message = event.message.message;
  if (message.startsWith('/time')) {
    // Обработка команды установки интервала обработки
    const timeArg = message.split(' ')[1];
    if (timeArg !== undefined) {
      const time = parseFloat(timeArg);
      if (!isNaN(time) && time >= 0) {
        processInterval = time * 1000; // Конвертируем секунды в миллисекунды
        const responseMsg = time === 0 ? '⚡️ Задержка отключена' : `🕝 ${time.toFixed(3)} с.`;
        await client.sendMessage(adminId, { message: responseMsg });
      } else {
        await client.sendMessage(adminId, { message: "/time <секунды[.миллисекунды]>" });
      }
    } else {
      await client.sendMessage(adminId, { message: "/time <секунды[.миллисекунды]>" });
    }
  } else if (message === '/start') {
    // Включение автоматического режима
    isAutoMode = true;
    await client.sendMessage(adminId, { message: "🤖" });
  } else if (message === '/stop') {
    // Выключение автоматического режима
    isAutoMode = false;
    await client.sendMessage(adminId, { message: "✋" });
  } else if (message.startsWith('/toggle')) {
    // Переключение различных функций системы
    const [_, feature] = message.split(' ');
    switch (feature) {
      case 'vision':
        isVisionEnabled = !isVisionEnabled;
        await client.sendMessage(adminId, { message: `Vision ${isVisionEnabled ? 'enabled' : 'disabled'}` });
        break;
      case 'cache':
      case 'obvious':
      case 'gpt':
      case 'mod':
        if (feature === 'mod') {
          if (!enabledChecks.has(feature)) {
            enabledChecks.clear();
            enabledChecks.add(feature);
            await client.sendMessage(adminId, { message: "Moderator check enabled, all other checks disabled" });
          } else {
            enabledChecks.delete(feature);
            // Включаем другие проверки при выключении режима модератора
            enabledChecks.add('cache');
            enabledChecks.add('obvious');
            enabledChecks.add('gpt');
            await client.sendMessage(adminId, { message: "Moderator check disabled, other checks enabled" });
          }
        } else {
          if (enabledChecks.has(feature)) {
            enabledChecks.delete(feature);
            await client.sendMessage(adminId, { message: `${feature} check disabled` });
          } else {
            enabledChecks.add(feature);
            await client.sendMessage(adminId, { message: `${feature} check enabled` });
          }
        }
        break;
      default:
        await client.sendMessage(adminId, { message: "Invalid feature. Use: vision, cache, obvious, gpt, mod" });
    }
  } else {
    // Вывод списка доступных команд
    // Вывод списка доступных команд
    const commandList = "/start /stop /time /toggle <feature>";
    const featureList = "Available features: vision, cache, obvious, gpt, mod";
    await client.sendMessage(adminId, { message: `❓ - ${commandList}\n${featureList}` });
  }
}

// ОБРАБОТКА СООБЩЕНИЙ
//--------------------------------------------------

// Функция для обработки входящих сообщений для проверки
async function checkMsg(event: NewMessageEvent): Promise<void> {
  try {
    if (event.message instanceof Api.Message) {
      const message = event.message;
      const checkInfo: CheckInfo = { messages: [message] };
      addToBuffer(checkInfo);
      console.log(`
Received Message for Check
ID: ${message.id}
Text: ${message.message?.substring(0, 100) || '[No text content]'}${message.message && message.message.length > 100 ? '...' : ''}
Media: ${message.media ? getMediaType(message.media) : 'No'}
`);

      // Обновляем время последнего полученного checkMsg
      lastCheckMsgTime = Date.now();

      // Сбрасываем существующий таймер и устанавливаем новый
      if (checkMsgTimeoutTimer) {
        clearTimeout(checkMsgTimeoutTimer);
      }
      checkMsgTimeoutTimer = setTimeout(handleCheckMsgTimeout, CHECK_MSG_TIMEOUT);
    }
  } catch (error) {
    console.error("Error handling check message:", error);
    await notifyAdmin("Error handling check message. Check logs.");
  }
}

// Функция для обработки сообщений о следующем отчете
async function handleNextReport(event: NewMessageEvent): Promise<void> {
  if (event.message instanceof Api.Message) {
    const message = event.message.message;
    if (!message) {
      console.log("Received empty message in handleNextReport");
      return;
    }

    if (message.includes("Send /next for a new spam report.")) {
      console.log("Received 'Send /next for a new spam report.' message. Sending /next...");
      await client.sendMessage(botId, { message: "/next" });
      resetRecoveryTimers();
    } else if (message === "No Reports Found" || 
               message === "Please select 😡 BAN or 😌 NO." || 
               message.includes("Sorry, an error has occurred during your request. Please try again later.")) {
      console.log("No reports or error occurred. Sending /undo...");
      await client.sendMessage(botId, { message: "/undo" });
      resetRecoveryTimers();
    }
  }
}

// Функция для обработки системных сообщений
async function sysMsg(event: NewMessageEvent): Promise<void> {
  try {
    const message = event.message.message;
    if (!message) {
      console.log("Received empty or non-text system info message");
      return;
    }

    // Стандартная обработка системной информации
    const complaintMatch = message.match(/😱(\d+)/);
    if (!complaintMatch) {
      console.log("Message doesn't contain complaint count, skipping system info processing");
      return;
    }

    let sysInfo: SysInfo = {
      hasLink: '',
      reportId: '',
      complaintCount: 0,
      source: '',
      sender: '',
      crowdOpinions: [],
      telegramSpamProbability: 0
    };

    sysInfo.complaintCount = parseInt(complaintMatch[1], 10);

    // Добавляем обработку вероятности спама от Telegram
    const spamProbabilityMatch = message.match(/🌚\s*(\d+)%/);
    if (spamProbabilityMatch) {
      sysInfo.telegramSpamProbability = parseInt(spamProbabilityMatch[1], 10) / 100;
    } else {
      sysInfo.telegramSpamProbability = 0;
    }

    const lines = message.split('\n');
    for (const line of lines) {
      if (line.startsWith('#r')) sysInfo.reportId = line.split(',')[0].trim();
      else if (line.startsWith('Source:') || line.startsWith('🗣 Source:'))
        sysInfo.source = line.replace('🗣 Source:', 'Source:').substring('Source:'.length).trim();
      else if (line.startsWith('Sender:'))
        sysInfo.sender = line.substring('Sender:'.length).trim();
      else if (line.includes('🔴'))
        sysInfo.hasLink = '🔴';
      else if (line.includes('– Flood') || line.includes('– Not Spam'))
        sysInfo.crowdOpinions.push(line.trim());
    }

    addSysInfoToBuffer(sysInfo);
    resetRecoveryTimers();

  } catch (error) {
    console.error("Error handling bot system info:", error);
    await notifyAdmin("Error handling bot system info. Check logs.");
  }
}

// Функция для определения типа медиа-контента
function getMediaType(media: Api.TypeMessageMedia): string {
  if (media instanceof Api.MessageMediaPhoto) return 'Photo';
  if (media instanceof Api.MessageMediaDocument) {
    const document = media.document;
    if (document instanceof Api.Document) {
      for (const attribute of document.attributes) {
        if (attribute instanceof Api.DocumentAttributeVideo) return 'Video';
        if (attribute instanceof Api.DocumentAttributeAudio)
          return attribute.voice ? 'Voice' : 'Audio';
        if (attribute instanceof Api.DocumentAttributeSticker) return 'Sticker';
        if (attribute instanceof Api.DocumentAttributeAnimated) return 'GIF';
      }
      return 'Document';
    }
  }
  if (media instanceof Api.MessageMediaWebPage) return 'Web Page';
  if (media instanceof Api.MessageMediaPoll) return 'Poll';
  if (media instanceof Api.MessageMediaGeo) return 'Location';
  if (media instanceof Api.MessageMediaVenue) return 'Venue';
  if (media instanceof Api.MessageMediaContact) return 'Contact';
  if (media instanceof Api.MessageMediaGame) return 'Game';
  if (media instanceof Api.MessageMediaInvoice) return 'Invoice';
  if (media instanceof Api.MessageMediaGeoLive) return 'Live Location';
  if (media instanceof Api.MessageMediaDice) return 'Dice';
  if (media instanceof Api.MessageMediaStory) return 'Story';
  return 'Unknown';
}

// ОБРАБОТКА БУФЕРА
//--------------------------------------------------
let reportBuffer: ReportBuffer = {
  messages: [],
  sysInfo: null,
  lastUpdateTime: Date.now()
}

// Функция для добавления сообщения в буфер
function addToBuffer(checkInfo: CheckInfo): void {
  const newMessageIds = new Set(checkInfo.messages.map(m => m.id));
  
  // Проверяем, есть ли уже такие сообщения в буфере
  const isNewMessage = checkInfo.messages.some(newMsg => 
    !reportBuffer.messages.some(existingMsg => existingMsg.id === newMsg.id)
  );

  if (isNewMessage) {
    // Удаляем дубликаты из существующего буфера
    reportBuffer.messages = reportBuffer.messages.filter(m => !newMessageIds.has(m.id));
    // Добавляем новые сообщения
    reportBuffer.messages.push(...checkInfo.messages);
    reportBuffer.lastUpdateTime = Date.now();
    console.log(`Added ${checkInfo.messages.length} new message(s) to buffer. Total messages in buffer: ${reportBuffer.messages.length}`);
  } else {
    console.log(`Skipped adding duplicate message(s) to buffer. Current buffer size: ${reportBuffer.messages.length}`);
  }
}

// Функция для добавления системной информации в буфер
function addSysInfoToBuffer(sysInfo: SysInfo): void {
  reportBuffer.sysInfo = sysInfo;
  reportBuffer.lastUpdateTime = Date.now();
}

// Функция для обработки буфера
async function processBuffer(): Promise<void> {
  if (reportBuffer.messages.length > 0 && reportBuffer.sysInfo) {
    const messages = [...reportBuffer.messages];
    const sysInfo = { ...reportBuffer.sysInfo };
    
    // Очищаем буфер перед обработкой
    reportBuffer.messages = [];
    reportBuffer.sysInfo = null;
    
    try {
      await processReport(messages, sysInfo);
    } catch (error) {
      console.error("Error processing report:", error);
      // В случае ошибки не возвращаем сообщения в буфер
    }
  }
}

// ОСНОВНАЯ ЛОГИКА ОБРАБОТКИ
//--------------------------------------------------

// Функция для обработки отчета о спаме
async function processReport(messages: Api.Message[], sysInfo: SysInfo): Promise<void> {
  const release = await processingMutex.acquire();
  try {
    processingStartTime = Date.now();
    isProcessing = true;

    const mediaTypes = messages.filter(m => m.media).map(m => getMediaType(m.media!));
    console.log(`
Processing Report: ${sysInfo.reportId}
Media Types: ${mediaTypes.join(', ') || 'None'}
Complaint Count: ${sysInfo.complaintCount}
Source: ${sysInfo.source}
Sender: ${sysInfo.sender}
Has Link: ${sysInfo.hasLink ? 'Yes' : 'No'}
`);

    let result: CheckResult = null;

    if (enabledChecks.has('mod')) {
      result = await checkModerators(messages, sysInfo);
    } else {
      if (enabledChecks.has('cache')) {
        result = await checkCache(messages);
        if (result) console.log("Cache check result:", result);
      }

      if (!result && enabledChecks.has('obvious')) {
        result = await checkObvious(messages, sysInfo);
        if (result) {
          if (result.isSpam === undefined) {
            console.log("Obvious check result (requires further checking):", result);
          } else {
            console.log("Obvious check result:", result);
          }
        }
      }

      if ((!result || result.isSpam === undefined) && enabledChecks.has('gpt')) {
        try {
          result = await gptChecker.check(messages, sysInfo);
          if (result) console.log("GPT check result:", result);
        } catch (error) {
          console.error("Error in GPT check:", error);
          result = { 
            isSpam: undefined,
            layer: 5, 
            reason: "Error in GPT check, undo required",
          };
        }
      }
    }

    if (result) {
      if (result.isSpam === undefined) {
        console.log("Undefined result, sending /undo");
        await client.sendMessage(botId, { message: "/undo" });
      } else {
        await handleResult(result, messages);
      }
    } else {
      console.log("No definitive result after all checks");
      if (isAutoMode) {
        await sendResult(false);
      }
    }

  } catch (error: unknown) {
    console.error("Error processing report:", error);
    if (error instanceof Error) {
      await notifyAdmin(`Error processing report: ${error.message}`);
    } else {
      await notifyAdmin(`Error processing report: ${String(error)}`);
    }
    await client.sendMessage(botId, { message: "/undo" });
    startRecovery();
  } finally {
    isProcessing = false;
    processingStartTime = null;
    release();

    console.log("Processing ended at:", new Date().toISOString());

    setImmediate(() => {
      if (reportBuffer.messages.length > 0 && reportBuffer.sysInfo) {
        processBuffer().catch(error => {
          console.error("Error processing buffer after ending previous processing:", error);
        });
      }
    });
  }
}

// ФУНКЦИИ ПРОВЕРКИ
//--------------------------------------------------

// Функция для проверки модераторами
async function checkModerators(messages: Api.Message[], sysInfo: SysInfo): Promise<CheckResult> {
  const reportId = sysInfo.reportId;
  let originalCheckMsgHandler: ((event: NewMessageEvent) => Promise<void>) | null = checkMsg;
  let originalSysMsgHandler: ((event: NewMessageEvent) => Promise<void>) | null = sysMsg;

  const checkMsgEvent = new NewMessage({ fromUsers: [botId], incoming: true, forwards: true });
  const sysMsgEvent = new NewMessage({ fromUsers: [botId], incoming: true, forwards: false, pattern: /😱\d+/ });

  const disableHandlers = () => {
    if (originalCheckMsgHandler) {
      client.removeEventHandler(originalCheckMsgHandler, checkMsgEvent);
    }
    if (originalSysMsgHandler) {
      client.removeEventHandler(originalSysMsgHandler, sysMsgEvent);
    }
  };

  const enableHandlers = () => {
    if (originalCheckMsgHandler) {
      client.addEventHandler(originalCheckMsgHandler, checkMsgEvent);
    }
    if (originalSysMsgHandler) {
      client.addEventHandler(originalSysMsgHandler, sysMsgEvent);
    }
  };

  try {
    // Отключаем обработчики перед началом проверки
    disableHandlers();

    // Шаг 1: Отправляем "/start" с задержкой
    await new Promise(resolve => setTimeout(resolve, processInterval));
    await client.sendMessage(botId, { message: "/start" });
    
    // Ожидаем ответное сообщение
    const startResponse = await waitForBotResponse("Hello there! Send /next to start processing reports.", 10000);
    if (!startResponse) {
      console.log("Не получен ожидаемый ответ на команду /start");
      enableHandlers();
      return null;
    }

    // Шаг 2: Отправляем reportId с задержкой
    await new Promise(resolve => setTimeout(resolve, processInterval));
    await client.sendMessage(botId, { message: reportId });
    
    // Ожидаем системное сообщение
    const sysMessage = await waitForBotResponse(/😱\d+/, 10000);
    if (!sysMessage) {
      console.log("Не получено системное сообщение после отправки reportId");
      enableHandlers();
      return null;
    }

    // Шаг 3: Анализируем системное сообщение
    const lines = sysMessage.message.split('\n');
    const moderationLines = lines.filter(line => line.includes("– Flood") || line.includes("– Not Spam"));
    
    let result: CheckResult | null = null;
    if (moderationLines.length > 0) {
      const hasFlood = moderationLines.some(line => line.includes("– Flood"));
      const hasNotSpam = moderationLines.some(line => line.includes("– Not Spam"));

      if (hasFlood && !hasNotSpam) {
        result = { isSpam: true, layer: 3, reason: "Moderators marked as Flood" };
      } else if (hasNotSpam) {
        result = { isSpam: false, layer: 3, reason: "Moderators marked as Not Spam" };
      }
    }

    // Шаг 4: Отправляем "/next" с задержкой
    await new Promise(resolve => setTimeout(resolve, processInterval));
    await client.sendMessage(botId, { message: "/next" });

    // Ожидаем ответ после /next
    const nextResponse = await waitForBotResponse(/.*/, 10000);
    if (nextResponse && nextResponse.message.includes("Please select 😡 BAN or 😌 NO.")) {
      // Если получено сообщение о выборе, отправляем результат
      await new Promise(resolve => setTimeout(resolve, processInterval));
      await sendResult(result?.isSpam ?? false);
    }

    return result || { isSpam: false, layer: 3, reason: "No clear moderator decision" };

  } catch (error) {
    console.error("Error in checkModerators:", error);
    return null;
  } finally {
    // Убедимся, что обработчики включены обратно в любом случае
    enableHandlers();
  }
}

// Вспомогательная функция для ожидания ответа от бота
async function waitForBotResponse(expectedResponse: string | RegExp, timeout = 10000): Promise<Api.Message | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.removeEventHandler(eventHandler, eventBuilder);
      resolve(null);
    }, timeout);
    
    const eventBuilder = new NewMessage({ fromUsers: [botId] });
    const eventHandler = async (event: NewMessageEvent) => {
      if (event.message instanceof Api.Message) {
        const messageText = event.message.message;
        if ((typeof expectedResponse === 'string' && messageText === expectedResponse) ||
            (expectedResponse instanceof RegExp && expectedResponse.test(messageText))) {
          clearTimeout(timer);
          client.removeEventHandler(eventHandler, eventBuilder);
          resolve(event.message);
        }
      }
    };

    client.addEventHandler(eventHandler, eventBuilder);
  });
}

// Функция для проверки кэша
async function checkCache(messages: Api.Message[]): Promise<CheckResult> {
  for (const message of messages) {
    const cachedEntry = await getFromCache(message);
    if (cachedEntry && message.message === cachedEntry.message && 
        (message.media ? getMediaHash(message.media) : '') === cachedEntry.mediaHash) {
      const isSpam = cachedEntry.response === '😡 SPAM';
      return {
        isSpam: isSpam,
        layer: 1,
        reason: `Cached result: ${cachedEntry.response}`
      };
    }
  }
  return null;
}

// Функция для проверки очевидного спама
async function checkObvious(messages: Api.Message[], sysInfo: SysInfo): Promise<CheckResult> {
  const mediaHashCounts = new Map<string, number>();
  const mediaTypeCounts = new Map<string, number>();
  const linkCounts = new Map<string, number>();
  const fileNameCounts = new Map<string, number>();

  // Проверка количества жалоб для медиа, файлов, ссылок, контактов и @юзернеймов
  if ((messages.some(m => m.media) || 
       messages.some(m => m.message && (m.message.includes('http') || m.message.includes('@') || m.message.match(/\+?[0-9]{10,14}/))) 
      ) && sysInfo.complaintCount > 2) {
    return {
      isSpam: true,
      layer: 2,
      reason: `High complaint count for message with media/links/contacts: ${sysInfo.complaintCount}`
    };
  }

  // Проверка имени отправителя на наличие URL или подозрительных фраз
  if (sysInfo.sender) {
    const lowerSender = sysInfo.sender.toLowerCase();
    const urlsInSender = lowerSender.match(urlRegex);
    if (urlsInSender && urlsInSender.length > 0) {
      return { isSpam: true, layer: 2, reason: `URL detected in sender name: ${urlsInSender[0]}` };
    }
    if (suspiciousPhrases.some(phrase => lowerSender.includes(phrase.toLowerCase()))) {
      return { isSpam: true, layer: 2, reason: "Suspicious phrase in sender name" };
    }
  }

  for (const message of messages) {
    // Проверка на наличие Stories (считаются спамом по умолчанию)
    if (message.media instanceof Api.MessageMediaStory) {
      return { isSpam: true, layer: 2, reason: "Stories are considered spam by default" };
    }

    // Проверка на наличие URL-кнопок
    if (message.replyMarkup instanceof Api.ReplyInlineMarkup) {
      for (const row of message.replyMarkup.rows) {
        for (const button of row.buttons) {
          if (button instanceof Api.KeyboardButtonUrl) {
            return { isSpam: true, layer: 2, reason: "Message contains URL button" };
          }
        }
      }
    }
    
    if (message.message) {
      const cleanedMessage = message.message.toLowerCase();
      
      // Проверка на наличие спам-фраз в тексте
      if (spamPhrases.some(phrase => cleanedMessage.includes(phrase.toLowerCase()))) {
        return { isSpam: true, layer: 2, reason: "Spam phrase detected in text" };
      }
      
      // Проверка на короткие спам-фразы
      if (shortSpamPhrases.some(phrase => new RegExp(`\\b${phrase}\\b`, 'i').test(cleanedMessage))) {
        return { isSpam: true, layer: 2, reason: "Short spam phrase detected in text" };
      }
      
      // Проверка на чрезмерное использование эмодзи
      const emojiCounts = new Map<string, number>();
      for (const char of cleanedMessage) {
        if (spamEmojis.includes(char) && emojiCounts.set(char, (emojiCounts.get(char) || 0) + 1).get(char)! > 3) {
          return { isSpam: true, layer: 2, reason: "Excessive use of spam emoji" };
        }
      }

      // Проверка на дублирование сообщений
      if (messages.length > 3 && new Set(messages.map(m => m.message)).size < messages.length * 0.7) {
        return { isSpam: true, layer: 2, reason: "Multiple similar messages in a short time" };
      }

      // Проверка на обещание высокого заработка или инвестиций
      const highPaymentRegex = /(?:от|до|>|)\s*\d{3,}\s*(?:₽|руб|р\.|₴|грн|usd|\$|€|евро)/i;
      const investmentRegex = /(?:инвест|invest|прибыль|profit|заработ|earn)/i;
      if (highPaymentRegex.test(cleanedMessage) || investmentRegex.test(cleanedMessage)) {
        return { isSpam: true, layer: 2, reason: "High payment promise or investment offer detected" };
      }

      // Проверка на предложение услуг
      if (/предостав(?:ля|им|ить)|помо(?:щь|жем)|услуг[иа]/i.test(cleanedMessage)) {
        return { isSpam: true, layer: 2, reason: "Offering services in suspicious context" };
      }

      // Проверка на упоминание документов в подозрительном контексте
      if (/(?:водительск|прав[а|о]|удостоверени[е|я])/i.test(cleanedMessage) && 
          /(?:помо(?:щь|жем)|услуг[иа]|предостав)/i.test(cleanedMessage)) {
        return { isSpam: true, layer: 2, reason: "Suspicious mention of documents or licenses" };
      }

      // Проверка на подозрительные ключевые слова
      const suspiciousKeywords = [
        'оплата после', 'широкий спектр услуг', 'работаем по всей', 
        'участникам скидки', 'помощь лишённым', 'замена иностранцам'
      ];
      if (suspiciousKeywords.some(keyword => cleanedMessage.includes(keyword.toLowerCase()))) {
        return { isSpam: true, layer: 2, reason: "Suspicious keywords detected" };
      }
      
      // Проверка на наличие и дублирование ссылок
      const urls = cleanedMessage.match(urlRegex) || [];
      for (const url of urls) {
        if (linkCounts.set(url, (linkCounts.get(url) || 0) + 1).get(url)! > 1) {
          return { isSpam: true, layer: 2, reason: "Duplicate links detected" };
        }
        if (isAdLink(url)) {
          return { isSpam: true, layer: 2, reason: "Advertisement link detected" };
        }
      }
      
      // Проверка на повторяющиеся символы
      const repeatingCharRegex = /(.)\1{50,}/;
      const repeatingCharMatch = cleanedMessage.match(repeatingCharRegex);
      if (repeatingCharMatch) {
        const repeatingChar = repeatingCharMatch[1];
        const harmlessRepeatingChars = new Set(['.', '-', '_', '~', '*', '=']);
        if (!harmlessRepeatingChars.has(repeatingChar)) {
          return { isSpam: true, layer: 2, reason: "Excessive repeating characters" };
        }
      }
      
      // Проверка на подозрительные фразы
      if (suspiciousPhrases.some(phrase => cleanedMessage.includes(phrase.toLowerCase()))) {
        return { isSpam: true, layer: 2, reason: "Suspicious phrase detected in message" };
      }
      
      // Проверка на избыточную контактную информацию
      const contactInfoCount = (cleanedMessage.match(/\+?[0-9]{10,14}/g) || []).length + 
                               (cleanedMessage.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g) || []).length;
      if (contactInfoCount > 1) return { isSpam: true, layer: 2, reason: "Excessive contact information" };
    }
    
    // Проверки для медиа-контента
    if (message.media) {
      const mediaType = getMediaType(message.media);
      const mediaHash = getMediaHash(message.media);
      
      // Проверка на дубликаты медиа
      if (mediaHashCounts.set(mediaHash, (mediaHashCounts.get(mediaHash) || 0) + 1).get(mediaHash)! > 1) {
        return { isSpam: true, layer: 2, reason: `Duplicate ${mediaType} detected` };
      }

      mediaTypeCounts.set(mediaType, (mediaTypeCounts.get(mediaType) || 0) + 1);

      // Проверка на чрезмерное количество медиа одного типа
      if (mediaTypeCounts.get(mediaType)! > 2) {
        return { isSpam: true, layer: 2, reason: `Excessive ${mediaType} content (${mediaTypeCounts.get(mediaType)} instances)` };
      }
      
      // Проверка документов на дубликаты и потенциально опасные расширения
      if (mediaType === 'Document' && message.media instanceof Api.MessageMediaDocument && 
          message.media.document instanceof Api.Document) {
        const fileName = message.media.document.attributes
          .find((attr): attr is Api.DocumentAttributeFilename => attr instanceof Api.DocumentAttributeFilename)?.fileName;
        
        if (fileName) {
          if (fileNameCounts.set(fileName, (fileNameCounts.get(fileName) || 0) + 1).get(fileName)! > 1) {
            return { isSpam: true, layer: 2, reason: "Duplicate files detected" };
          }
          if (dangerousExtensions.includes(path.extname(fileName).toLowerCase())) {
            return { isSpam: true, layer: 2, reason: "Potentially harmful file detected" };
          }
        }
      }
    }
  }

  // Проверка на упоминания конкретных пользователей для финансовых услуг
  const financialUserMentions = messages.some(m => 
    m.message && /@\w+/.test(m.message) && 
    /(?:инвест|invest|прибыль|profit|заработ|earn|crypto|крипто)/i.test(m.message)
  );
  if (financialUserMentions) {
    return { isSpam: true, layer: 2, reason: "Mention of specific users for financial services" };
  }

  // Проверка на срочность в финансовых решениях
  const urgencyInFinancialDecisions = messages.some(m => 
    m.message && 
    /(?:спешите|hurry|срочно|urgent|limited time|ограниченное время)/i.test(m.message) &&
    /(?:инвест|invest|прибыль|profit|заработ|earn|crypto|крипто)/i.test(m.message)
  );
  if (urgencyInFinancialDecisions) {
    return { isSpam: true, layer: 2, reason: "Urgency in financial decisions" };
  }

  return null;
}

// Функция для проверки с использованием GPT
async function checkGPT(
  messages: Api.Message[], 
  sysInfo: SysInfo, 
  preprocessedMessage: string, 
  visionResults: VisionResult[],
  isSpam: boolean | undefined
): Promise<CheckResult> {
  try {
    isProcessing = true;

    // Если isSpam уже определен (например, для одиночного GIF), возвращаем результат немедленно
    if (isSpam !== undefined) {
      console.log(`GPT Check skipped. Predefined result: ${isSpam ? 'SPAM' : 'NOT SPAM'}`);
      return {
        isSpam: isSpam,
        layer: 5,
        reason: `Predefined result for special case`
      };
    }

    const deepCheckResult = await gptDeep(preprocessedMessage, sysInfo, visionResults);

    // Используем порог в 70 для определения спама
    const isSpamResult = deepCheckResult.spamScore > 70;
    const response = isSpamResult ? '😡 SPAM' : '😌 NO';
    await saveToCache(messages[0], response, deepCheckResult.spamScore);

    console.log(`GPT Check Result - Spam Score: ${deepCheckResult.spamScore}, Classification: ${isSpamResult ? 'SPAM' : 'NOT SPAM'}`);

    return {
      isSpam: isSpamResult,
      layer: 5,
      reason: `GPT Spam Score: ${deepCheckResult.spamScore.toFixed(2)}`
    };

  } catch (error) {
    console.error('Error in GPT check:', error);
    return { 
      isSpam: undefined,
      layer: 5, 
      reason: "Error in GPT check, undo required",
    };
  } finally {
    isProcessing = false;
  }
}

// ПРЕДОБРАБОТКА И АНАЛИЗ
//--------------------------------------------------

// Функция для предобработки и анализа сообщений
async function preprocessAndAnalyze(messages: Api.Message[]): Promise<{ preprocessedMessage: string, visionResults: VisionResult[], isSpam: boolean | undefined }> {
  const message = messages[0];
  const mediaTypes = messages.filter(m => m.media).map(m => getMediaType(m.media!));
  let visionResults: VisionResult[] = [];
  let isSpam: boolean | undefined = undefined;

  // Проверка на одиночный GIF-файл
  if (messages.length === 1 && mediaTypes.length === 1 && mediaTypes[0] === 'GIF') {
    console.log("Single GIF message detected, marking as not spam");
    return {
      preprocessedMessage: "[MEDIA: GIF]",
      visionResults: [],
      isSpam: false
    };
  }

  // Если анализ изображений включен и есть медиа-контент без текста, выполняем анализ
  if (isVisionEnabled && mediaTypes.length > 0 && !message.message) {
    const visionPromises = messages
      .filter(m => m.media && !m.message)
      .map(analyzeMediaMessage);
    visionResults = await Promise.all(visionPromises);
    
    // Формируем краткое описание результатов анализа изображений
    const visionSummary = visionResults
      .map(result => {
        let summary = `${result.type}: ${result.labels.slice(0, 3).join(', ')}`;
        if (result.safeSearch) {
          const safeSearchFlags = Object.entries(result.safeSearch)
            .filter(([_, value]) => ['LIKELY', 'VERY_LIKELY'].includes(value as string))
            .map(([key, _]) => key);
          if (safeSearchFlags.length > 0) {
            summary += ` [SafeSearch: ${safeSearchFlags.join(', ')}]`;
          }
        }
        return summary;
      })
      .join('. ');
    
    // Предобрабатываем сообщение и добавляем результаты анализа изображений
    let preprocessedMessage = preprocessMessage(message.message || '', mediaTypes, visionResults);
    preprocessedMessage += ` Vision: ${visionSummary}`;

    // Ограничиваем длину preprocessedMessage
    preprocessedMessage = preprocessedMessage.slice(0, 1500);

    return { preprocessedMessage, visionResults, isSpam };
  }

  // Если анализ изображений отключен или нет подходящего медиа, просто предобрабатываем текст сообщения
  return { 
    preprocessedMessage: preprocessMessage(message.message || '', mediaTypes), 
    visionResults,
    isSpam
  };
}

// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
//--------------------------------------------------

// Функция для проверки, является ли ссылка рекламной
function isAdLink(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  return adKeywordsAndDomains.some(item => lowercaseUrl.includes(item.toLowerCase())) ||
         urlShorteners.some(shortener => lowercaseUrl.includes(shortener));
}

// Функция для получения хэша медиа-контента
function getMediaHash(media: Api.TypeMessageMedia): string {
  if (media instanceof Api.MessageMediaPhoto && media.photo)
    return `photo:${media.photo.id.toString()}`;
  if (media instanceof Api.MessageMediaDocument && media.document)
    return `doc:${media.document.id.toString()}`;
  if (media instanceof Api.MessageMediaWebPage && media.webpage && 'id' in media.webpage)
    return `webpage:${media.webpage.id.toString()}`;
  if (media instanceof Api.MessageMediaPoll && media.poll)
    return `poll:${media.poll.id}`;
  if (media instanceof Api.MessageMediaGeo && media.geo && 'long' in media.geo && 'lat' in media.geo)
    return `geo:${media.geo.long},${media.geo.lat}`;
  if (media instanceof Api.MessageMediaContact)
    return `contact:${media.phoneNumber}`;
  if (media instanceof Api.MessageMediaGame && media.game)
    return `game:${media.game.id}`;
  if (media instanceof Api.MessageMediaInvoice)
    return `invoice:${media.title}`;
  if (media instanceof Api.MessageMediaGeoLive && media.geo && 'long' in media.geo && 'lat' in media.geo)
    return `geolive:${media.geo.long},${media.geo.lat}`;
  if (media instanceof Api.MessageMediaDice)
    return `dice:${media.value}`;
  if (media instanceof Api.MessageMediaStory)
    return `story:${media.id}`;
  return 'unknown_media';
}

// Функция для предобработки текста сообщения
function preprocessMessage(message: string, mediaTypes: string[], visionResults?: VisionResult[]): string {
  // Удаляем лишние пробелы и переносы строк, ограничиваем длину сообщения
  let processed = message
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

  // Заменяем персональные данные на маркеры
  processed = processed
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL]')
    .replace(/\+?[0-9]{10,14}/g, '[PHONE]')
    .replace(/@(\w+)(?!bot\b)/g, '@[USERNAME]')
    .replace(/https?:\/\/\S+/g, '[URL]');
  
  // Добавляем информацию о типах медиа-контента
  if (mediaTypes.length > 0) {
    processed += ` [MEDIA: ${mediaTypes.join(', ')}]`;
  }

  // Добавляем текст, извлеченный из изображений (если есть)
  if (visionResults && visionResults.length > 0) {
    const textFromImages = visionResults
      .filter(result => result.textAnnotations && result.textAnnotations.length > 0)
      .map(result => result.textAnnotations![0].description)
      .join(' ');
    
    if (textFromImages) {
      processed += ` [TEXT_FROM_IMAGE: ${textFromImages.slice(0, 200)}]`;
    }
  }

  return processed;
}

// Функция для получения размера файла
async function getFileSize(mediaMessage: Api.Message): Promise<number> {
  if (mediaMessage.media instanceof Api.MessageMediaPhoto) {
    const photo = mediaMessage.media.photo;
    if (photo instanceof Api.Photo) {
      // Находим размер наименьшего доступного изображения
      const smallestSize = photo.sizes.reduce((prev, curr) => {
        if (curr instanceof Api.PhotoSize && 'size' in curr) {
          return curr.size < (prev instanceof Api.PhotoSize && 'size' in prev ? prev.size : Infinity) ? curr : prev;
        }
        return prev;
      });
      
      if (smallestSize instanceof Api.PhotoSize && 'size' in smallestSize) {
        return smallestSize.size;
      }
    }
    // Если не удалось получить размер, возвращаем примерный размер для небольших изображений
    return 100 * 1024; // 100 KB as a fallback for photos
  } else if (mediaMessage.media instanceof Api.MessageMediaDocument) {
    const document = mediaMessage.media.document;
    if (document instanceof Api.Document) {
      return document.size.toJSNumber();
    }
  }
  // Если не удалось определить размер, возвращаем значение по умолчанию
  return 1 * 1024 * 1024; // 1 MB as a default fallback
}

// Функция для анализа изображения с помощью Google Vision API
async function analyzeImageWithVision(imageBuffer: Buffer): Promise<{ labels: string[], safeSearch: any, textAnnotations?: { description: string }[] }> {
  const [result] = await visionClient.annotateImage({
    image: { content: imageBuffer },
    features: [
      { type: 'LABEL_DETECTION' },
      { type: 'SAFE_SEARCH_DETECTION' },
      { type: 'TEXT_DETECTION' }
    ],
  });

  const labels = result.labelAnnotations?.map(label => label.description || '') || [];
  const safeSearch = result.safeSearchAnnotation || {};
  const textAnnotations = result.textAnnotations?.map(annotation => ({
    description: annotation.description || ''
  }));

  return { labels, safeSearch, textAnnotations };
}

// Функция для анализа медиа-сообщения
async function analyzeMediaMessage(mediaMessage: Api.Message): Promise<VisionResult> {
  const mediaType = getMediaType(mediaMessage.media!);
  
  console.log(`Analyzing media: ${mediaType}`);

  let partialResult: Partial<VisionResult> = { type: mediaType, labels: [], safeSearch: {} };

  // Проверяем, есть ли текст в сообщении
  if (mediaMessage.message) {
    console.log('Skipping Vision analysis for message with text');
    return partialResult as VisionResult;
  }

  // Пропускаем анализ видео
  if (mediaType === 'Video') {
    console.log('Skipping Vision analysis for video');
    return partialResult as VisionResult;
  }

  // Проверяем размер файла
  const fileSize = await getFileSize(mediaMessage);
  if (fileSize > 1024 * 1024) { // 1 MB
    console.log(`Skipping Vision analysis for large file (${fileSize} bytes)`);
    return partialResult as VisionResult;
  }

  try {
    // Загружаем медиа-контент
    const imageBuffer = await client.downloadMedia(mediaMessage.media!) as Buffer;
    if (imageBuffer) {
      console.log(`Successfully downloaded media, size: ${imageBuffer.length} bytes`);
      const { labels, safeSearch, textAnnotations } = await analyzeImageWithVision(imageBuffer);
      partialResult = { ...partialResult, labels, safeSearch, textAnnotations };
    }
  } catch (error) {
    console.error(`Error downloading or processing media:`, error);
  }

  return partialResult as VisionResult;
}

// GPT ПРОМПТЫ И ФУНКЦИИ
//--------------------------------------------------

// Функция для глубокого анализа с помощью GPT
async function gptDeep(message: string, sysInfo: SysInfo, visionResults: VisionResult[]): Promise<{ 
  isSpam: boolean; 
  spamScore: number; 
}> {
  // Оптимизированный промпт для GPT
  const gptPrompt = `Analyze multilingual Telegram messages for spam. Classify as spam (1) or not spam (0). Prioritize protecting users from scams and harmful content while allowing normal interactions. Consider all context, but prioritize message content. Be cautious with short or emoji messages.

Spam (1) if clear:
1.1. Commercial: Unsolicited ads, aggressive promotions
1.2. Scams: Phishing, fake giveaways, get-rich-quick schemes
1.3. Malicious: Malware, viruses
1.4. Adult: Explicit content, unsolicited services
1.5. Crypto/Financial: Unrealistic promises, quick money schemes
1.6. Deceptive: Impersonation, misleading info
1.7. Unwanted: Excessive invites, chain messages
1.8. Job offers: Unsolicited or suspicious
1.9. Self-promotion: Unrelated channels/groups
1.10. Urgent financial decisions: Pressuring users
1.11. Private channels: Attempts to move conversations for commercial purposes
1.12. Excessive URLs: Especially shortened/unrelated to discussion
1.13. Bot-like behavior: Repetitive messages
1.14. Specific usernames: Mentioned for financial services
1.15. Bypass attempts: Excessive emojis/symbols to avoid filters
1.16. Easy money promises: Including minimal effort claims
1.17. Language mismatch: Different from group's primary, especially if promotional
1.18. Illegal services: Fake documents, licenses

Not Spam (0) for:
0.1. Normal chat: Greetings, casual conversation
0.2. Short messages: Single words, numbers, emojis
0.3. Group-related: Content relevant to the group
0.4. Opinions/reactions: Personal views, responses
0.5. Questions/replies: Any inquiry or response
0.6. Information sharing: Links, news (unless clearly spam)
0.7. Business talk: Unless clearly a scam
0.8. Arguments: Unless extremely offensive
0.9. Bot commands: Standard interactions
0.10. Political content: Discussions, opinions (unless harmful)
0.11. Strong language: Within context of discussion

Key factors (importance order):
1. Message content and intent (any language)
2. User behavior and message pattern
3. Source relevance and group context
4. Links/media presence and nature
5. Complaint count and Telegram's spam probability (consider context)

Ambiguous cases:
- Prioritize message content over group context for short/greeting messages
- Allow normal interactions even in suspiciously named groups
- Favor free speech for political/controversial content unless clearly harmful
- Cautious with explicit invitations, allow ambiguous if not clearly spam
- Extra vigilant about easy money promises, especially in mismatched language

Output: Single digit (0 or 1) followed by brief reasoning (max 10 words).`;

  // Формирование строки с результатами анализа изображений
  const visionAnalysis = visionResults.length > 0
    ? visionResults.map(vr => 
        `${vr.type}: ${vr.labels.slice(0, 3).join(', ')}` +
        (vr.safeSearch ? ` [${Object.entries(vr.safeSearch)
          .filter(([_, v]) => v === 'LIKELY' || v === 'VERY_LIKELY')
          .map(([k, _]) => k).join(', ')}]` : '') +
        (vr.textAnnotations ? ` Text: ${vr.textAnnotations[0]?.description.slice(0, 50)}` : '')
      ).join(' | ')
    : 'No vision data';

  // Формирование промпта для пользователя
  const userPrompt = `Analyze:
"${message}"
Complaints: ${sysInfo.complaintCount}
Source: ${sysInfo.source}
Sender: ${sysInfo.sender}
Link: ${sysInfo.hasLink ? 'Yes' : 'No'}
Spam Prob: ${sysInfo.telegramSpamProbability}
Vision: ${visionAnalysis}

Classification (0/1) and brief reason:`;

  try {
    const response = await retryGptRequest(
      () => openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: gptPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 30,
        temperature: 0.1,
      }),
      2,
      30000,
      35000
    );

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty GPT-4o response');

    const [classification, ...reasonParts] = content.trim().split(' ');
    const reason = reasonParts.join(' ');

    if (classification !== '0' && classification !== '1') {
      throw new Error('Invalid GPT response: expected 0 or 1');
    }

    const isSpam = classification === '1';
    let spamScore = isSpam ? 70 : 30;  // Изменили начальные значения

    spamScore += Math.min(3, sysInfo.complaintCount);  // Уменьшили влияние жалоб
    spamScore += sysInfo.telegramSpamProbability * 10;
    if (sysInfo.hasLink) spamScore += 2;
    
    const adultContent = visionResults.some(vr => vr.safeSearch?.adult === 'LIKELY' || vr.safeSearch?.adult === 'VERY_LIKELY');
    if (adultContent) spamScore += 10;

    const violenceContent = visionResults.some(vr => vr.safeSearch?.violence === 'LIKELY' || vr.safeSearch?.violence === 'VERY_LIKELY');
    if (violenceContent) spamScore += 5;

    const textInImages = visionResults.flatMap(vr => vr.textAnnotations || []).map(ta => ta.description.toLowerCase());
    const spamKeywordsInImages = textInImages.some(text => 
      spamPhrases.some(phrase => text.includes(phrase.toLowerCase())) ||
      shortSpamPhrases.some(phrase => new RegExp(`\\b${phrase}\\b`, 'i').test(text))
    );
    if (spamKeywordsInImages) spamScore += 15;

    spamScore = Math.min(100, spamScore);

    console.log(`GPT Analysis: ${isSpam ? 'SPAM' : 'NOT SPAM'}, Score: ${spamScore}, Reason: ${reason}`);

    return {
      isSpam: spamScore > 85,  // Оставили порог без изменений
      spamScore: spamScore
    };

  } catch (error) {
    console.error('Error in gptDeep:', error);
    return performSimplifiedCheck(message);
  }
}

// Функция для упрощенной проверки в случае ошибки основного анализа
async function performSimplifiedCheck(message: string): Promise<{
  isSpam: boolean;
  spamScore: number;
}> {
  try {
    const simplePrompt = "Is this message spam? Respond with a single digit: 0 for not spam, 1 for spam.\n\n" + message;
    const simpleResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: simplePrompt }],
      max_tokens: 1,
      temperature: 0.0,
    });
    const simpleAnswer = simpleResponse.choices[0]?.message?.content?.trim();
    
    if (simpleAnswer !== '0' && simpleAnswer !== '1') {
      throw new Error('Invalid GPT response: expected 0 or 1');
    }
    
    const isSpam = simpleAnswer === '1';
    const spamScore = isSpam ? 75 : 25;

    return {
      isSpam,
      spamScore
    };
  } catch (simpleError) {
    console.error('Error in simplified GPT check:', simpleError);
    return {
      isSpam: false,
      spamScore: 50
    };
  }
}

// Функция для повторения запроса к GPT в случае ошибки
async function retryGptRequest<T>(
requestFunc: () => Promise<T>,
maxRetries: number,
timeout: number,
finalTimeout: number
): Promise<T> {
let attempts = 0;
const startTime = Date.now();
isProcessing = true;

try {
  while (attempts < maxRetries) {
    try {
      const timeLeft = finalTimeout - (Date.now() - startTime);
      if (timeLeft <= 0) {
        throw new Error('Final timeout reached');
      }

      const result = await Promise.race([
        requestFunc(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Request timeout')), Math.min(timeout, timeLeft))
        ),
      ]);

      return result;
    } catch (error) {
      attempts++;
      if (attempts >= maxRetries || Date.now() - startTime >= finalTimeout) {
        throw error;
      }
      console.log(`Retrying GPT request, attempt ${attempts}`);
    }
  }

  throw new Error('Max retries reached');
} finally {
  isProcessing = false;
}
}

// ОБРАБОТКА РЕЗУЛЬТАТОВ
//--------------------------------------------------

// Функция для обработки результата проверки
async function handleResult(result: CheckResult, messages: Api.Message[]): Promise<void> {
if (result) {
  await cacheResult(messages, result);
  
  if (isAutoMode) {
    await sendResult(result.isSpam === true);
  } else {
    console.log("Manual mode: Result not sent automatically");
  }
} else {
  if (isAutoMode) {
    await sendResult(false);
  }
}

resetRecoveryTimers();
}

// Функция для отправки результата проверки
async function sendResult(isSpam: boolean): Promise<void> {
if (isAutoMode) {
  // Применяем задержку перед отправкой результата
  await new Promise(resolve => setTimeout(resolve, processInterval));
  await client.sendMessage(botId, { message: isSpam ? '😡 SPAM' : '😌 NO' });
}
}

// Функция для кэширования результата проверки
async function cacheResult(messages: Api.Message[], result: ResultInfo): Promise<void> {
for (const message of messages) {
  await saveToCache(message, result.isSpam ? '😡 SPAM' : '😌 NO');
}
}

// Функция для обработки таймаута проверки сообщения
async function handleCheckMsgTimeout(): Promise<void> {
const timeSinceLastCheckMsg = Date.now() - lastCheckMsgTime;
if (timeSinceLastCheckMsg >= CHECK_MSG_TIMEOUT) {
  console.log("No checkMsg received for 55 seconds");
  await notifyAdmin("No checkMsg received for 55 seconds");
  await client.sendMessage(botId, { message: "/undo" });
}
}

// УПРАВЛЕНИЕ КЭШЕМ
//--------------------------------------------------

// Функция для сохранения результата в кэш
async function saveToCache(message: Api.Message, response: string, gptScore?: number): Promise<void> {
const redis = getRedisConnection();
const key = `msg:${message.id}`;
const mediaType = message.media ? getMediaType(message.media) : 'None';
const mediaHash = message.media ? getMediaHash(message.media) : '';
const entry: CacheEntry = {
  message: message.message?.slice(0, 100) || '', // Ограничиваем длину сохраняемого сообщения
  mediaType,
  mediaHash,
  response,
  timestamp: Date.now(),
  gptScore
};

await redis.set(key, JSON.stringify(entry), 'EX', CACHE_TTL);

if (gptScore !== undefined) {
  const contentKey = `gpt:${crypto.createHash('md5').update(message.message || '').digest('hex')}`;
  await redis.set(contentKey, JSON.stringify({ response, gptScore }), 'EX', CACHE_TTL);
}

// Асинхронная проверка использования кэша
setImmediate(async () => {
  try {
    await checkCacheUsage();
  } catch (error) {
    console.error('Error in checkCacheUsage:', error);
  }
});
}

// Функция для получения результата из кэша
async function getFromCache(message: Api.Message): Promise<CacheEntry | null> {
const redis = getRedisConnection();
const cachedData = await redis.get(`msg:${message.id}`);
return cachedData ? JSON.parse(cachedData) : null;
}

// Функция для проверки использования кэша
async function checkCacheUsage(): Promise<void> {
const redis = getRedisConnection();
const info = await redis.info('memory');
const [usedMemory, maxMemory] = info.match(/used_memory:(\d+).*maxmemory:(\d+)/s)?.slice(1).map(Number) || [0, 0];

if (maxMemory > 0 && usedMemory / maxMemory > MAX_CACHE_USAGE) {
  await clearOldCache();
}
}

// Функция для очистки старых записей в кэше
async function clearOldCache(): Promise<void> {
const redis = getRedisConnection();
const keys = await redis.keys('msg:*');
const toDelete = Math.floor(keys.length * 0.2); // Увеличиваем количество удаляемых ключей

if (toDelete > 0) {
  const pipeline = redis.pipeline();
  keys.slice(0, toDelete).forEach(key => pipeline.del(key));
  await pipeline.exec();
}
}

// Пул соединений Redis
const redisPool = Array.from({ length: REDIS_POOL_SIZE }, () => 
new Redis(process.env.REDIS_URL || '')
);

// Функция для получения соединения Redis из пула
function getRedisConnection(): Redis {
return redisPool[Math.floor(Math.random() * REDIS_POOL_SIZE)];
}

// ПРОЦЕСС ВОССТАНОВЛЕНИЯ
//--------------------------------------------------

// Функция для запуска процесса восстановления
async function startRecovery(): Promise<void> {
if (isProcessing) {
  if (processingStartTime && Date.now() - processingStartTime > MAX_PROCESSING_TIME) {
    console.log("Processing timeout reached, starting recovery");
    isProcessing = false;
    processingStartTime = null;
  } else {
    console.log("Recovery skipped: message is still being processed");
    return;
  }
}

if (recoveryTimer) clearTimeout(recoveryTimer);
if (nextTimer) clearTimeout(nextTimer);

recoveryTimer = setTimeout(async () => {
  if (isProcessing) {
    console.log("Recovery canceled: message processing completed");
    return;
  }

  try {
    await client.sendMessage(botId, { message: '/undo' });
    
    const previousMessage = await new Promise<Api.Message>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for previous message')), 10000);
      
      const eventBuilder = new NewMessage({});
      const handler = (event: NewMessageEvent) => {
        if (event.message instanceof Api.Message && event.message.senderId && event.message.senderId.toJSNumber() === botId) {
          clearTimeout(timeout);
          client.removeEventHandler(handler, eventBuilder);
          resolve(event.message);
        }
      };

      client.addEventHandler(handler, eventBuilder);
    });

    if (previousMessage) {
      await processReport([previousMessage], { hasLink: '', reportId: '', complaintCount: 0, source: '', sender: '', crowdOpinions: [], telegramSpamProbability: 0 });
      return;
    }
  } catch (error) {
    console.error('Error in recovery process:', error);
  }

  nextTimer = setTimeout(async () => {
    await client.sendMessage(botId, { message: '/next' });
    
    setTimeout(async () => {
      await client.sendMessage(botId, { message: '😌 NO' });
      
      const longRecoveryTimer = setInterval(async () => {
        await client.sendMessage(botId, { message: '/next' });
      }, 30 * 60 * 1000);
      setTimeout(() => {
        clearInterval(longRecoveryTimer);
        notifyAdmin("Recovery process failed after multiple attempts.");
      }, 5 * 60 * 60 * 1000);
    }, 2000);
  }, 6000);
}, 20000);
}

// Функция для сброса таймеров восстановления
function resetRecoveryTimers() {
if (recoveryTimer) clearTimeout(recoveryTimer);
if (nextTimer) clearTimeout(nextTimer);
recoveryTimer = null;
nextTimer = null;
}

// ОБРАБОТКА ОШИБОК И ОЧИСТКА
//--------------------------------------------------

// Обработка необработанных исключений
process.on('uncaughtException', async (error) => {
console.error('Uncaught Exception:', error);
await cleanup();
process.exit(1);
});

// Обработка необработанных отклонений промисов
process.on('unhandledRejection', async (reason, promise) => {
console.error('Unhandled Rejection at:', promise, 'reason:', reason);
await cleanup();
process.exit(1);
});

// Функция очистки ресурсов перед завершением работы
async function cleanup() {
await Promise.all(redisPool.map(redis => redis.quit()));
if (client) {
  await client.disconnect();
}
}

// ОСНОВНАЯ ФУНКЦИЯ
//--------------------------------------------------

// Основная функция приложения
async function main() {
try {
  client = await initClient();
  app.listen(port, () => console.log(`Server is running on port ${port}`));

  // Добавление обработчиков событий
  client.addEventHandler(adminMsg, new NewMessage({ fromUsers: [adminId], incoming: true }));
  client.addEventHandler(checkMsg, new NewMessage({ fromUsers: [botId], incoming: true, forwards: true }));
  client.addEventHandler(sysMsg, new NewMessage({ fromUsers: [botId], incoming: true, forwards: false, pattern: /😱\d+/ }));
  
  // Обновленный обработчик для различных системных сообщений
  client.addEventHandler(handleNextReport, new NewMessage({ fromUsers: [botId], incoming: true, forwards: false }));

  console.log("Bot is ready...");
    await client.connect();
    setInterval(processBuffer, 1000);
    
    // Инициализируем первый таймер для checkMsg
    checkMsgTimeoutTimer = setTimeout(handleCheckMsgTimeout, CHECK_MSG_TIMEOUT);
    
    // Уведомляем администратора о успешном запуске
    await notifyAdmin("✅");

  } catch (error) {
    // Логирование критической ошибки и уведомление администратора
    console.error("Critical error in main function:", error);
    await notifyAdmin("❌", error);
  }
}

// Запуск основной функции
main().catch(console.error);

// Дополнительные комментарии к структуре и логике работы приложения:

// 1. Инициализация и настройка:
//    - Загрузка конфигурации из переменных окружения
//    - Инициализация клиента Telegram
//    - Настройка подключения к Redis для кэширования
//    - Инициализация Google Cloud Vision для анализа изображений

// 2. Обработка входящих сообщений:
//    - Сообщения от бота добавляются в буфер для проверки
//    - Системные сообщения с информацией о жалобах обрабатываются отдельно

// 3. Процесс проверки (функция processReport):
//    - Проверки выполняются в следующем порядке:
//      a. Проверка кэша (checkCache)
//      b. Проверка очевидного спама (checkObvious)
//      c. Проверка GPT (checkGPT)
//    - Используется паттерн "Цепочка обязанностей" для гибкости и расширяемости

// 4. Препроцессинг и анализ медиа:
//    - Перед проверками выполняется препроцессинг сообщения
//    - Для медиаконтента выполняется анализ с помощью Google Vision API (если включено)
//    - Результаты анализа добавляются к preprocessedMessage для дальнейшей обработки

// 5. Условия определения спама:
//    - Высокое количество жалоб
//    - Наличие URL или подозрительных фраз в имени отправителя
//    - Наличие спам-фраз в тексте сообщения
//    - Чрезмерное использование определенных эмодзи
//    - Наличие дублирующихся или рекламных ссылок
//    - Подозрительные шаблоны сообщений
//    - Избыточная контактная информация
//    - Дублирующиеся медиафайлы или файлы с потенциально вредоносными расширениями
//    - Высокая оценка вероятности спама от GPT (с динамическим порогом)

// 6. Обработка результатов:
//    - Если сообщение определено как спам, отправляется соответствующий ответ боту
//    - Результат сохраняется в кэш для будущих проверок
//    - В случае неоднозначных результатов, сообщение считается не спамом

// 7. Дополнительные функции:
//    - Механизм восстановления для обработки ошибок и зависаний
//    - Управление сессией бота для оптимизации взаимодействия
//    - Система кэширования для ускорения повторных проверок
//    - Возможность включения/отключения отдельных проверок через команды администратора
//    - Настройка задержки между обработкой сообщений
//    - Автоматический и ручной режимы работы

// Этот код представляет собой комплексную систему проверки спама для Telegram,
// использующую различные методы и API для достижения высокой точности определения спама
// при сохранении возможности нормального общения пользователей.