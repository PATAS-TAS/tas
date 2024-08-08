// app.ts

// IMPORTS
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

dotenv.config();

// CONFIGS
//--------------------------------------------------

const app = express();
const processingMutex = new Mutex();
const port = process.env.PORT || 3000;
const apiHash = process.env.API_HASH!;
const phoneNumber = process.env.PHONE_NUMBER!;
const apiId = parseInt(process.env.API_ID!);
const botId = parseInt(process.env.BOT_ID!);
const adminId = parseInt(process.env.ADMIN_ID!);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '86400', 10);
const visionClient = new ImageAnnotatorClient({projectId: process.env.GOOGLE_CLOUD_PROJECT,});
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const REDIS_POOL_SIZE = 5;
const MAX_CACHE_USAGE = 0.9;
const MAX_PROCESSING_TIME = 59 * 1000; // 59 секунд


let recoveryTimer: NodeJS.Timeout | null = null;
let nextTimer: NodeJS.Timeout | null = null;
let client: TelegramClient;
let processInterval = 1000;
let isAutoMode = true; // переключатель авто режима
let isProcessing = false;
let isVisionEnabled = true; // переключатель анализа медиа
let enabledChecks = new Set(['cache', 'obvious', 'gpt']); // список включенных проверок
let processingStartTime: number | null = null;


// INTERFACES
//--------------------------------------------------
interface CheckInfo {
  messages: Api.Message[];
  storyCaption?: string;
}

interface SysInfo {
  hasLink: string;
  reportId: string;
  complaintCount: number;
  source: string;
  sender: string;
  crowdOpinions: string[];
  telegramSpamProbability: number;
}

interface ResultInfo {
  isSpam: boolean | undefined;
  layer: number;
  reason: string;
  visionResults?: VisionResult[];
  illegalContentDetected?: boolean;
  combinedMessage?: string;  
}

interface CacheEntry {
  message?: string;
  mediaHash?: string;
  mediaType?: string;
  timestamp: number;
  gptScore?: number;
  response: string;
}

interface ReportBuffer {
  messages: Api.Message[];
  sysInfo: SysInfo | null;
  lastUpdateTime: number;
}

interface VisionResult {
  type: string;
  labels: string[];
  safeSearch: any;
  textAnnotations?: { description: string }[];
}

type CheckResult = ResultInfo | null;

interface CheckFunction {
  (messages: Api.Message[], sysInfo: SysInfo): Promise<CheckResult>;
}

// SPAM CHECKER CLASSES
//--------------------------------------------------
abstract class SpamChecker {
  protected next: SpamChecker | null = null;

  setNext(checker: SpamChecker): SpamChecker {
    this.next = checker;
    return checker;
  }

  abstract check(messages: Api.Message[], sysInfo: SysInfo): Promise<CheckResult>;

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

class CacheChecker extends SpamChecker {
  async check(messages: Api.Message[]): Promise<CheckResult> {
    return checkCache(messages);
  }
}

class ObviousChecker extends SpamChecker {
  check: CheckFunction = async (messages, sysInfo) => {
    return checkObvious(messages, sysInfo);
  }
}

class GPTChecker extends SpamChecker {
  check: CheckFunction = async (messages, sysInfo) => {
    return checkGPT(messages, sysInfo);
  }
}

// Создание цепочки проверок
const cacheChecker = new CacheChecker();
const obviousChecker = new ObviousChecker();
const gptChecker = new GPTChecker();

cacheChecker
  .setNext(obviousChecker)
  .setNext(gptChecker);

// CLIENT INITIALIZATION
//--------------------------------------------------
async function initClient(): Promise<TelegramClient> {
  const sessionString = process.env.SESSION_STRING || "";
  const stringSession = new StringSession(sessionString);
  
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  if (!sessionString) {
    await client.start({
      phoneNumber: async () => phoneNumber,
      password: async () => await promptInput('Password'),
      phoneCode: async () => await promptInput('Phone code'),
      onError: (err) => console.log(err),
    });

    const newSessionString = stringSession.save();
    console.log("New session string:", newSessionString);
    console.log("Please set this as SESSION_STRING in your .env file");
    
    try {
      await updateEnvFile("SESSION_STRING", newSessionString);
      console.log("SESSION_STRING has been updated in .env file");
    } catch (error) {
      console.error("Failed to update .env file. Please set SESSION_STRING manually.");
    }
  } else {
    await client.connect();
  }
  return client;
}

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

async function promptInput(inputType: string, isPassword: boolean = false): Promise<string> {
  const response = await prompts({
    type: isPassword ? 'password' : 'text',
    name: 'value',
    message: `Please enter your ${inputType}:`,
    validate: (value) => value.length > 0 || `Please enter a valid ${inputType}`
  });
  return response.value;
}

// ADMIN FUNCTIONS
//--------------------------------------------------
async function notifyAdmin(message: string, error?: any): Promise<void> {
  try {
    let fullMessage = `TAS: ${message}`;
    if (error) fullMessage += `\n\nError details: ${error.message || error}`;
    await client.sendMessage(adminId, { message: fullMessage });
  } catch (notifyError) {
    console.error('Error notifying admin:', notifyError);
  }
}

async function adminMsg(event: NewMessageEvent): Promise<void> {
  const message = event.message.message;
  if (message.startsWith('/time')) {
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
    isAutoMode = true;
    await client.sendMessage(adminId, { message: "🤖" });
  } else if (message === '/stop') {
    isAutoMode = false;
    await client.sendMessage(adminId, { message: "✋" });
  } else if (message.startsWith('/toggle')) {
    const [_, feature] = message.split(' ');
    switch (feature) {
      case 'vision':
        isVisionEnabled = !isVisionEnabled;
        await client.sendMessage(adminId, { message: `Vision ${isVisionEnabled ? 'enabled' : 'disabled'}` });
        break;
      case 'cache':
      case 'obvious':
      case 'gpt':
        if (enabledChecks.has(feature)) {
          enabledChecks.delete(feature);
          await client.sendMessage(adminId, { message: `${feature} check disabled` });
        } else {
          enabledChecks.add(feature);
          await client.sendMessage(adminId, { message: `${feature} check enabled` });
        }
        break;
      default:
        await client.sendMessage(adminId, { message: "Invalid feature. Use: vision, cache, obvious, gpt" });
    }
  } else {
    const commandList = "/start /stop /time /toggle <feature>";
    const featureList = "Available features: vision, cache, obvious, gpt";
    await client.sendMessage(adminId, { message: `❓ - ${commandList}\n${featureList}` });
  }
}

// MESSAGE HANDLING
//--------------------------------------------------
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
    }
  } catch (error) {
    console.error("Error handling check message:", error);
    await notifyAdmin("Error handling check message. Check logs.");
  }
}

async function sysMsg(event: NewMessageEvent): Promise<void> {
  try {
    const message = event.message.message;
    if (!message) {
      console.log("Received empty or non-text system info message");
      return;
    }

    // Обработка специфических системных сообщений
    if (message === "Sorry, this action can no longer be undone.\nSend /next for a new spam report.") {
      console.log("Action can no longer be undone. Sending /next...");
      await client.sendMessage(botId, { message: "/next" });
      resetRecoveryTimers();
      return;
    }

    if (message === "No Reports Found" || message === "Please select 😡 BAN or 😌 NO." || message.includes("Sorry, an error has occurred during your request. Please try again later.")) {
      console.log("No reports or error occurred. Sending /undo...");
      await client.sendMessage(botId, { message: "/undo" });
      resetRecoveryTimers();
      return;
    }

    // Стандартная обработка системной информации
    const complaintMatch = message.match(/😱(\d+)/);
    if (!complaintMatch) return;

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

// BUFFER HANDLING
//--------------------------------------------------
let reportBuffer: ReportBuffer = {
  messages: [],
  sysInfo: null,
  lastUpdateTime: Date.now()
}

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

function addSysInfoToBuffer(sysInfo: SysInfo): void {
  reportBuffer.sysInfo = sysInfo;
  reportBuffer.lastUpdateTime = Date.now();
}

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

// MAIN PROCESSING LOGIC
//--------------------------------------------------

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
      result = await checkGPT(messages, sysInfo);
      if (result) console.log("GPT check result:", result);
    }

    if (result && result.isSpam !== undefined) {
      await handleResult(result, messages);
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
    startRecovery();
  } finally {
    isProcessing = false;
    processingStartTime = null;
    release();

    // Логирование завершения обработки
    console.log("Processing ended at:", new Date().toISOString());

    // Проверка и обработка буфера сообщений
    setImmediate(() => {
      if (reportBuffer.messages.length > 0 && reportBuffer.sysInfo) {
        processBuffer().catch(error => {
          console.error("Error processing buffer after ending previous processing:", error);
        });
      }
    });
  }
}

// CHECKING FUNCTIONS
//--------------------------------------------------
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

//--------------------------------------------------

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
    if (message.media instanceof Api.MessageMediaStory) {
      return { isSpam: true, layer: 2, reason: "Stories are considered spam by default" };
    }

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
      
      if (spamPhrases.some(phrase => phrase.toLowerCase().split(/\s+/).every(word => cleanedMessage.includes(word)))) {
        return { isSpam: true, layer: 2, reason: "Spam phrase detected" };
      }
      
      if (shortSpamPhrases.some(phrase => new RegExp(`\\b${phrase}\\b`, 'i').test(cleanedMessage))) {
        return { isSpam: true, layer: 2, reason: "Short spam phrase detected" };
      }
      
      const emojiCounts = new Map<string, number>();
      for (const char of cleanedMessage) {
        if (spamEmojis.includes(char) && emojiCounts.set(char, (emojiCounts.get(char) || 0) + 1).get(char)! > 4) {
          return { isSpam: true, layer: 2, reason: "Excessive use of spam emoji" };
        }
      }

      if (messages.length > 5 && new Set(messages.map(m => m.message)).size < messages.length * 0.5) {
        return {
          isSpam: true,
          layer: 2,
          reason: "Multiple similar messages in a short time"
        };
      }

      // Проверка на обещание высокого заработка
      const highPaymentRegex = /(?:от|до|>|)\s*\d{4,}\s*(?:₽|руб|р\.|₴|грн|usd|\$|€|евро)/i;
      if (highPaymentRegex.test(cleanedMessage)) {
        return { isSpam: true, layer: 2, reason: "High payment promise detected" };
      }
      
      const urls = cleanedMessage.match(urlRegex) || [];
      for (const url of urls) {
        if (linkCounts.set(url, (linkCounts.get(url) || 0) + 1).get(url)! > 2) {
          return { isSpam: true, layer: 2, reason: "Duplicate links detected" };
        }
        if (isAdLink(url)) {
          return { isSpam: true, layer: 2, reason: "Advertisement link detected" };
        }
      }
      
      const repeatingCharRegex = /(.)\1{99,}/;
      const repeatingCharMatch = cleanedMessage.match(repeatingCharRegex);
      if (repeatingCharMatch) {
        const repeatingChar = repeatingCharMatch[1];
        const harmlessRepeatingChars = new Set(['.', '-', '_', '~', '*', '=']);
        if (!harmlessRepeatingChars.has(repeatingChar)) {
          return { isSpam: true, layer: 2, reason: "Excessive repeating characters" };
        }
      }
      
      if (suspiciousPhrases.some(phrase => cleanedMessage.includes(phrase.toLowerCase()))) {
        return { isSpam: true, layer: 2, reason: "Suspicious phrase detected in message" };
      }
      
      const contactInfoCount = (cleanedMessage.match(/\+?[0-9]{10,14}/g) || []).length + 
                               (cleanedMessage.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g) || []).length;
      if (contactInfoCount > 2) return { isSpam: true, layer: 2, reason: "Excessive contact information" };
    }
    
    if (message.media) {
      const mediaType = getMediaType(message.media);
      const mediaHash = getMediaHash(message.media);
      
      if (mediaHashCounts.set(mediaHash, (mediaHashCounts.get(mediaHash) || 0) + 1).get(mediaHash)! > 2) {
        return { isSpam: true, layer: 2, reason: `Duplicate ${mediaType} detected` };
      }

      mediaTypeCounts.set(mediaType, (mediaTypeCounts.get(mediaType) || 0) + 1);

      if (mediaTypeCounts.get(mediaType)! > 2) {
        return { isSpam: true, layer: 2, reason: `Excessive ${mediaType} content (${mediaTypeCounts.get(mediaType)} instances)` };
      }
      
      if (mediaType === 'Document' && message.media instanceof Api.MessageMediaDocument && 
          message.media.document instanceof Api.Document) {
        const fileName = message.media.document.attributes
          .find((attr): attr is Api.DocumentAttributeFilename => attr instanceof Api.DocumentAttributeFilename)?.fileName;
        
        if (fileName) {
          if (fileNameCounts.set(fileName, (fileNameCounts.get(fileName) || 0) + 1).get(fileName)! > 2) {
            return { isSpam: true, layer: 2, reason: "Duplicate files detected" };
          }
          if (dangerousExtensions.includes(path.extname(fileName).toLowerCase())) {
            return { isSpam: true, layer: 2, reason: "Potentially harmful file detected" };
          }
        }
      }
    }
  }

  return null;
}

//--------------------------------------------------

async function checkGPT(messages: Api.Message[], sysInfo: SysInfo): Promise<CheckResult> {
  const { preprocessedMessage, visionResults } = await preprocessAndAnalyze(messages);

  try {
    isProcessing = true;

    // Применяем determineSpamStatus перед GPT-проверкой
    const preliminaryResult = determineSpamStatus(sysInfo, preprocessedMessage);
    
    // Всегда выполняем GPT-проверку
    const deepCheckResult = await gptDeep(preprocessedMessage, sysInfo, preliminaryResult.preliminarySpamScore);

    const response = deepCheckResult.isSpam ? '😡 SPAM' : '😌 NO';
    await saveToCache(messages[0], response, deepCheckResult.spamScore * 100);

    // Используем результат GPT-проверки
    return {
      isSpam: deepCheckResult.isSpam,
      layer: 5,
      reason: `Preliminary: ${preliminaryResult.reason}. GPT: ${deepCheckResult.reasons.join(", ")}`
    };

  } catch (error) {
    console.error('Error in GPT check:', error);
    return { 
      isSpam: false,
      layer: 5, 
      reason: "Error in GPT check, manual review required",
    };
  } finally {
    isProcessing = false;
  }
}

function determineSpamStatus(sysInfo: SysInfo, message: string): { preliminarySpamScore: number; reason: string } {
  let spamScore = 0;

  // Учитываем количество жалоб, но с меньшим весом
  if (sysInfo.complaintCount > 0) {
    spamScore += 0.05 * Math.min(sysInfo.complaintCount, 10);
  }

  // Учитываем вероятность спама от Телеграма
  spamScore += sysInfo.telegramSpamProbability * 0.5;

  // Проверяем на ключевые слова и паттерны
  const lowercaseMessage = message.toLowerCase();
  const spamKeywords = ['работа', 'заработок', 'награда', 'деньги', '🧧', 'прямо сейчас', 'срочно'];
  for (const keyword of spamKeywords) {
    if (lowercaseMessage.includes(keyword)) {
      spamScore += 0.1;
    }
  }

  // Проверяем на наличие username'ов в тексте сообщения (не в Sender или Source)
  const usernameMatches = message.match(/@[a-zA-Z0-9_]{5,}/g);
  if (usernameMatches && usernameMatches.length > 0) {
    spamScore += 0.1 * Math.min(usernameMatches.length, 3); // Максимум 0.3 за username'ы
  }

  // Проверяем на наличие цифр (возможные суммы денег)
  if (/\d{3,}/.test(message)) {
    spamScore += 0.1;
  }

  // Проверяем источник сообщения
  if (sysInfo.source.toLowerCase().includes('работа') || sysInfo.source.toLowerCase().includes('заработок')) {
    spamScore += 0.2;
  }

  // Проверяем на иностранные символы (например, китайские)
  if (/[\u4e00-\u9fa5]/.test(message)) {
    spamScore += 0.2;
  }

  // Ограничиваем итоговый спам-скор
  spamScore = Math.min(spamScore, 1);

  return { 
    preliminarySpamScore: spamScore, 
    reason: `Preliminary spam score: ${spamScore.toFixed(2)}` 
  };
}

function determineGptTemperature(message: string, sysInfo: SysInfo, preliminarySpamScore: number): number {
  let baseTemperature = 0.1;
  
  // Увеличиваем температуру для длинных сообщений
  if (message.length > 200) {
    baseTemperature += 0.1;
  }
  
  // Учитываем количество жалоб
  if (sysInfo.complaintCount > 5) {
    baseTemperature += 0.1;
  } else if (sysInfo.complaintCount > 2) {
    baseTemperature += 0.05;
  }
  
  // Учитываем вероятность спама от Telegram
  if (sysInfo.telegramSpamProbability > 0.7) {
    baseTemperature -= 0.05; // Уменьшаем для высокой вероятности спама
  } else if (sysInfo.telegramSpamProbability < 0.3) {
    baseTemperature += 0.05; // Увеличиваем для низкой вероятности спама
  }
  
  // Учитываем предварительный спам-скор
  if (preliminarySpamScore > 0.7) {
    baseTemperature -= 0.05;
  } else if (preliminarySpamScore < 0.3) {
    baseTemperature += 0.05;
  }
  
  // Учитываем наличие ссылок
  if (sysInfo.hasLink === 'Yes') {
    baseTemperature += 0.05;
  }
  
  // Ограничиваем итоговую температуру
  return Math.max(0.1, Math.min(0.5, baseTemperature));
}

function determineMaxTokens(message: string, sysInfo: SysInfo): number {
  let baseTokens = 500;  // Начальное значение

  // Увеличиваем токены для длинных сообщений
  const messageLength = message.length;
  if (messageLength > 500) {
    baseTokens += Math.min(500, messageLength - 500);
  }

  // Учитываем сложность анализа
  if (sysInfo.complaintCount > 3 || sysInfo.telegramSpamProbability > 0.5) {
    baseTokens += 200;
  }

  // Учитываем наличие ссылок или медиа
  if (sysInfo.hasLink === 'Yes' || message.includes('[MEDIA:')) {
    baseTokens += 100;
  }

  // Ограничиваем максимальное количество токенов
  return Math.min(2000, Math.max(500, baseTokens));
}

// PREPROCESSING AND ANALYSIS
//--------------------------------------------------
async function preprocessAndAnalyze(messages: Api.Message[]): Promise<{ preprocessedMessage: string, visionResults: VisionResult[] }> {
  const message = messages[0];
  const mediaTypes = messages.filter(m => m.media).map(m => getMediaType(m.media!));
  let preprocessedMessage = preprocessMessage(message.message || '', mediaTypes);

  let visionResults: VisionResult[] = [];
  if (isVisionEnabled) {
    visionResults = await Promise.all(messages.filter(m => m.media).map(async (mediaMessage) => {
      return analyzeMediaMessage(mediaMessage);
    }));
    
    const visionSummary = visionResults.map(result => 
      `Vision analysis (${result.type}): ${result.labels.join(', ')}. SafeSearch: ${JSON.stringify(result.safeSearch)}`
    ).join(' ');
    
    preprocessedMessage += ' ' + visionSummary;
  }

  return { preprocessedMessage, visionResults };
}

// HELPER FUNCTIONS
//--------------------------------------------------
function isAdLink(url: string): boolean {
  const lowercaseUrl = url.toLowerCase();
  return adKeywordsAndDomains.some(item => lowercaseUrl.includes(item.toLowerCase())) ||
         urlShorteners.some(shortener => lowercaseUrl.includes(shortener));
}

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

async function waitForBotResponse(expectedPattern: string, timeout: number = 10000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeEventHandler(handler, eventBuilder);
      reject(new Error(`Timeout waiting for bot response: ${expectedPattern}`));
    }, timeout);
    
    const eventBuilder = new NewMessage({
      fromUsers: [botId],
      incoming: true
    });

    const handler = (event: NewMessageEvent) => {
      if (event.message instanceof Api.Message) {
        const messageText = event.message.message || '';
        if (new RegExp(expectedPattern).test(messageText)) {
          clearTimeout(timer);
          client.removeEventHandler(handler, eventBuilder);
          resolve(messageText);
        }
      }
    };

    client.addEventHandler(handler, eventBuilder);
  });
}

function preprocessMessage(message: string, mediaTypes: string[]): string {
  let processed = message.split('\n').slice(1).join('\n').trim();
  processed = processed.slice(0, 1000).replace(/[^\S\s]/g, '')
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL]')
      .replace(/\+?[0-9]{10,14}/g, '[PHONE]')
      .replace(/@(\w+)(?!bot\b)/g, '@[USERNAME]')
      .replace(/\s+/g, ' ')
      .replace(/https?:\/\/\S+/g, '[URL]');
  
  if (mediaTypes.length > 0) {
      processed += ` [MEDIA: ${mediaTypes.join(', ')}]`;
  }
  return processed.trim();
}

async function getFileSize(mediaMessage: Api.Message): Promise<number> {
  if (mediaMessage.media instanceof Api.MessageMediaPhoto) {
    const photo = mediaMessage.media.photo;
    if (photo instanceof Api.Photo) {
      const smallestSize = photo.sizes.reduce((prev, curr) => {
        if ('size' in curr && 'size' in prev) {
          return curr.size < prev.size ? curr : prev;
        }
        return prev;
      }, photo.sizes[0] as Api.PhotoSize);
      
      return 'size' in smallestSize ? smallestSize.size : Infinity;
    }
  } else if (mediaMessage.media instanceof Api.MessageMediaDocument) {
    const document = mediaMessage.media.document;
    if (document instanceof Api.Document) {
      return document.size.toJSNumber();
    }
  }
  return Infinity;
}

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

async function analyzeMediaMessage(mediaMessage: Api.Message): Promise<VisionResult> {
  const fileSize = await getFileSize(mediaMessage);
  const mediaType = getMediaType(mediaMessage.media!);
  
  if (fileSize > MAX_FILE_SIZE) {
    console.log(`Skipping Vision analysis for large file (${fileSize} bytes)`);
    return { type: mediaType, labels: [], safeSearch: {} };
  }

  let imageBuffer: Buffer | null = null;

  if (mediaMessage.media instanceof Api.MessageMediaPhoto) {
    imageBuffer = await client.downloadMedia(mediaMessage.media) as Buffer;
  } else if (mediaMessage.media instanceof Api.MessageMediaDocument) {
    const document = mediaMessage.media.document;
    if (document instanceof Api.Document) {
      const videoAttribute = document.attributes.find(attr => attr instanceof Api.DocumentAttributeVideo) as Api.DocumentAttributeVideo | undefined;
      const stickerAttribute = document.attributes.find(attr => attr instanceof Api.DocumentAttributeSticker) as Api.DocumentAttributeSticker | undefined;
      
      if (videoAttribute) {
        // Получаем миниатюру видео
        const thumbnail = document.thumbs?.find(thumb => thumb instanceof Api.PhotoSize) as Api.PhotoSize | undefined;
        if (thumbnail) {
          try {
            imageBuffer = await client.downloadMedia(mediaMessage.media, {
              thumb: 0 // Загружаем первую доступную миниатюру
            }) as Buffer;
          } catch (error) {
            console.error('Error downloading video thumbnail:', error);
            return { type: mediaType, labels: [], safeSearch: {} };
          }
        } else {
          console.log(`No thumbnail available for video`);
          return { type: mediaType, labels: [], safeSearch: {} };
        }
      } else if (stickerAttribute || mediaType === 'GIF') {
        imageBuffer = await client.downloadMedia(mediaMessage.media) as Buffer;
      } else {
        console.log(`Skipping analysis for ${mediaType}`);
        return { type: mediaType, labels: [], safeSearch: {} };
      }
    }
  } else if (mediaMessage.media instanceof Api.MessageMediaStory) {
    const storyMedia = await client.downloadMedia(mediaMessage.media);
    if (storyMedia instanceof Buffer) {
      imageBuffer = storyMedia;
    }
  }

  if (imageBuffer) {
    const { labels, safeSearch, textAnnotations } = await analyzeImageWithVision(imageBuffer);
    return { type: mediaType, labels, safeSearch, textAnnotations };
  }

  return { type: mediaType, labels: [], safeSearch: {} };
}

// GPT PROMPTS AND FUNCTIONS
//--------------------------------------------------

const gptPrompt = `Analyze multilingual Telegram message for spam. Consider all context provided. Provide a concise response with at most 3 reasons. Consider the complaint count and Telegram's spam probability, but don't rely solely on these factors. Output JSON only.

Key factors:
1. Message content (any language, be aware of potential language barriers)
2. Complaint count (1-2 complaints is ok, but the more complaints the more suspicious)
3. Source relevance (consider if the message is appropriate for the chat topic)
4. Language use (natural vs. suspicious mixing, but don't overemphasize language differences in international groups)
5. Links presence (absence of links doesn't necessarily mean it's not spam)
6. Google Cloud Vision analysis results (if present)
7. Telegram's spam probability (consider, but don't rely heavily on low probabilities)
8. Preliminary spam score

Spam indicators (based on Telegram rules): 
- Outright commerce, ads (text and ad-related content)
- Scams and phishing attempts
- Chain letters, viral stories
- Endless walls of meaningless text or line breaks
- Extremely fast flashing effects, screamers
- Any non-advertising text (including insults, emoji) is NOT spam

Non-spam indicators:
- Normal chat conversation relevant to the group topic
- Short messages or commands that might be part of a conversation or bot interaction
- Legitimate news/politics relevant to the group
- Standard bot commands
- Appropriate emoji use
- Natural multilingual content within context of the group
- Messages in different languages in international groups

Additional considerations:
- The absence of links or media doesn't automatically mean the message is safe
- Low Telegram spam probability shouldn't be a strong indicator of non-spam
- Consider the message content and intent, not just its structure
- Short messages are not inherently suspicious; consider potential context
- In international groups, messages in different languages are normal
- Offensive or abusive content is NOT necessarily spam according to Telegram rules

Provide a JSON response with the following structure:
{
  "isSpam": boolean,
  "spamScore": number (0-1),
  "reasons": [string] (max 3 items),
}

Be thorough in analysis. Provide concise reasons. Flag any unusual patterns or concerns.
Be cautious about classifying short messages or different languages as spam, especially in international groups.
Remember that offensive content is not automatically spam according to Telegram rules.`;

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

async function gptDeep(message: string, sysInfo: SysInfo, preliminarySpamScore: number): Promise<{ 
  isSpam: boolean; 
  spamScore: number; 
  reasons: string[];
}> {
  const userPrompt = `Analyze in detail:
Message: "${message}"
Complaints: ${sysInfo.complaintCount}
Source: ${sysInfo.source}
Sender: ${sysInfo.sender}
Has Link: ${sysInfo.hasLink ? 'Yes' : 'No'}
Telegram Spam Probability: ${sysInfo.telegramSpamProbability * 100}%
Preliminary Spam Score: ${preliminarySpamScore}

Consider carefully: Is the message appropriate for the group context? Could it be a normal part of a conversation or bot interaction? In international groups, different languages are normal. Remember that offensive content is not automatically spam according to Telegram rules.
`;

  const temperature = determineGptTemperature(message, sysInfo, preliminarySpamScore);
  const maxTokens = determineMaxTokens(message, sysInfo);

  try {
    const response = await retryGptRequest(
      () => openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: gptPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: maxTokens,
        temperature: temperature,
      }),
      2,
      50000,
      55000
    );

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from GPT-4o');
    }

    let result;
    try {
      const cleanContent = content.replace(/^```json\s*|\s*```$/g, '').trim();
      result = JSON.parse(cleanContent);
      
      if (typeof result.isSpam !== 'boolean' || 
          typeof result.spamScore !== 'number' || 
          !Array.isArray(result.reasons)) {
        throw new Error('Invalid response structure from GPT');
      }

      if (result.spamScore < 0 || result.spamScore > 1) {
        console.warn(`Invalid spamScore: ${result.spamScore}. Clamping to [0, 1] range.`);
        result.spamScore = Math.max(0, Math.min(1, result.spamScore));
      }

      if (result.reasons.length === 0) {
        console.warn('No reasons provided. Adding default reason.');
        result.reasons.push('No specific reason provided');
      }

    } catch (parseError) {
      console.error('Error parsing GPT response:', parseError);
      console.log('Raw GPT response:', content);
      return await performSimplifiedCheck(message, 'GPT analysis inconclusive, simplified check performed');
    }

    console.log(`Used temperature: ${temperature}, max_tokens: ${maxTokens}, isSpam: ${result.isSpam}, spamScore: ${result.spamScore}`);

    return {
      isSpam: result.isSpam,
      spamScore: result.spamScore,
      reasons: result.reasons
    };
  } catch (error) {
    console.error('Error in gptDeep:', error);
    return await performSimplifiedCheck(message, 'Error in main GPT analysis, simplified check performed');
  }
}

async function performSimplifiedCheck(message: string, reason: string): Promise<{
  isSpam: boolean;
  spamScore: number;
  reasons: string[];
}> {
  try {
    const simplePrompt = "Is the following message spam? Answer only 'yes' or 'no':\n\n" + message;
    const simpleResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: simplePrompt }],
      max_tokens: 100,
      temperature: 0.0,
    });
    const simpleAnswer = simpleResponse.choices[0]?.message?.content?.toLowerCase() || '';
    const isSpam = simpleAnswer.includes('yes');
    const spamScore = isSpam ? 0.9 : 0.1;

    return {
      isSpam: isSpam,
      spamScore: spamScore,
      reasons: [reason]
    };
  } catch (simpleError) {
    console.error('Error in simplified GPT check:', simpleError);
    return {
      isSpam: true,
      spamScore: 0.7,
      reasons: ['Error in both main and simplified GPT analysis']
    };
  }
}

// RESULT HANDLING
//--------------------------------------------------
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

async function sendResult(isSpam: boolean): Promise<void> {
  if (isAutoMode) {
    await new Promise(resolve => setTimeout(resolve, processInterval));
    await client.sendMessage(botId, { message: isSpam ? '😡 SPAM' : '😌 NO' });
  }
}

async function cacheResult(messages: Api.Message[], result: ResultInfo): Promise<void> {
  for (const message of messages) {
    await saveToCache(message, result.isSpam ? '😡 SPAM' : '😌 NO');
  }
}

// CACHE MANAGEMENT
//--------------------------------------------------
async function saveToCache(message: Api.Message, response: string, gptScore?: number): Promise<void> {
  const redis = getRedisConnection();
  const key = `msg:${message.id}`;
  const mediaType = message.media ? getMediaType(message.media) : 'None';
  const mediaHash = message.media ? getMediaHash(message.media) : '';
  const entry: CacheEntry = {
    message: message.message || '',
    mediaType,
    mediaHash,
    response,
    timestamp: Date.now(),
    gptScore
  };
  
  if (gptScore !== undefined) {
    const contentKey = `gpt:${crypto.createHash('md5').update(message.message || '').digest('hex')}`;
    await redis.set(contentKey, JSON.stringify({ response, gptScore, mediaType, mediaHash }), 'EX', CACHE_TTL);
  }

  await redis.set(key, JSON.stringify(entry), 'EX', CACHE_TTL);
  await checkCacheUsage();
}

async function getFromCache(message: Api.Message): Promise<CacheEntry | null> {
  const redis = getRedisConnection();
  const cachedData = await redis.get(`msg:${message.id}`);
  return cachedData ? JSON.parse(cachedData) : null;
}

async function checkCacheUsage(): Promise<void> {
  const redis = getRedisConnection();
  const info = await redis.info('memory');
  const [usedMemory, maxMemory] = info.match(/used_memory:(\d+).*maxmemory:(\d+)/s)?.slice(1).map(Number) || [0, 0];
  
  if (maxMemory > 0 && usedMemory / maxMemory > MAX_CACHE_USAGE) {
    await clearOldCache();
  }
}

async function clearOldCache(): Promise<void> {
  const redis = getRedisConnection();
  const keys = await redis.keys('msg:*');
  const toDelete = Math.floor(keys.length * 0.1);
  
  const entries = await Promise.all(
    keys.slice(0, toDelete).map(async (key: string) => {
      const value = await redis.get(key);
      return value ? JSON.parse(value) as CacheEntry : null;
    })
  );

  const sortedKeys = entries
    .filter((entry): entry is CacheEntry => entry !== null)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((_, index) => keys[index]);
  
  if (sortedKeys.length > 0) {
    await redis.del(...sortedKeys);
  }
}

const redisPool = Array.from({ length: REDIS_POOL_SIZE }, () => 
  new Redis(process.env.REDIS_URL || '')
);

function getRedisConnection(): Redis {
  return redisPool[Math.floor(Math.random() * REDIS_POOL_SIZE)];
}

// RECOVERY PROCESS
//--------------------------------------------------
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

function resetRecoveryTimers() {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  if (nextTimer) clearTimeout(nextTimer);
  recoveryTimer = null;
  nextTimer = null;
}

// ERROR HANDLING AND CLEANUP
//--------------------------------------------------
process.on('uncaughtException', async (error) => {
  console.error('Uncaught Exception:', error);
  await cleanup();
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  await cleanup();
  process.exit(1);
});

async function cleanup() {
  await Promise.all(redisPool.map(redis => redis.quit()));
  if (client) {
    await client.disconnect();
  }
}

// MAIN FUNCTION
//--------------------------------------------------
async function main() {
  try {
    client = await initClient();
    app.listen(port, () => console.log(`Server is running on port ${port}`));

    client.addEventHandler(adminMsg, new NewMessage({ fromUsers: [adminId], incoming: true }));
    client.addEventHandler(checkMsg, new NewMessage({ fromUsers: [botId], incoming: true, forwards: true }));
    client.addEventHandler(sysMsg, new NewMessage({ fromUsers: [botId], incoming: true, forwards: false, pattern: /😱\d+/ }));

    console.log("Bot is ready...");
    await client.connect();
    setInterval(processBuffer, 1000);
    await notifyAdmin("✅");

  } catch (error) {
    console.error("Critical error in main function:", error);
    await notifyAdmin("❌", error);
  }
}

main().catch(console.error);