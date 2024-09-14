import { Api } from 'telegram/tl/index.js';
import { StringSession } from 'telegram/sessions/index.js';
import { TelegramClient } from 'telegram/index.js';
import { NewMessage, NewMessageEvent } from 'telegram/events/NewMessage.js';
import { ChatCompletionContentPart, ChatCompletionMessageParam } from 'openai/src/resources/index.js';
import { createObjectCsvWriter } from 'csv-writer';
import schedule from 'node-schedule';
import bigInt from "big-integer";
import winston from 'winston';
import express from 'express';
import dotenv from 'dotenv';
import OpenAI, { APIError } from 'openai';
import Redis from 'ioredis';
import { tmpdir } from 'os';
import { join } from 'path';
import pkg from 'pg';
import { LRUCache } from 'lru-cache';
import { createHash } from 'crypto';
import os from 'os';

dotenv.config();

// Environment variables
const BOT_ID = process.env.BOT_ID!;
const PORT = process.env.PORT || 3000;
const API_HASH = process.env.API_HASH!;
const ADMIN_ID = process.env.ADMIN_ID!;
const REDIS_URL = process.env.REDIS_URL!;
const DATABASE_URL = process.env.DATABASE_URL!;
const API_ID = parseInt(process.env.API_ID!, 10);
const DEEP_LOG = process.env.DEEP_LOG === 'true';
const SESSION_STRING = process.env.SESSION_STRING!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const BOT_ACCESS_HASH = process.env.BOT_ACCESS_HASH!;

// Constants
let COMMAND_DELAY = 50;
let PROCESSING_DELAY = 0;
const DB_SCHEMA_VERSION = '1.0';
const MEDIA_EXPIRY = 30; // 30 seconds
const ENABLE_GPT_MEDIA_ANALYSIS = true;
const MAX_CACHE_SIZE_MB = 100; // 100 MB
const GPT_RETRY_DELAY = 10000; // 10 seconds
const MAX_PROCESSING_TIME = 55000; // 55 seconds
const REDIS_BATCH_INTERVAL = 10 * 60 * 1000; // 10 minutes
const MIN_BUFFER_DELAY = 100;
const MAX_BUFFER_DELAY = 500;
let currentBufferDelay = MIN_BUFFER_DELAY;
let isShuttingDown = false;
let apiRequestsCount = 0;
let apiTokensUsed = 0;

// Initialize Express app
const app = express();

// Initialize Redis
const redis = new Redis.Redis(REDIS_URL);

// Initialize PostgreSQL
const { Pool } = pkg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Initialize OpenAI
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const gptCheckCache = new LRUCache<string, SpamDecision>({
  max: 1000, // Максимальное количество кэшированных результатов
  ttl: 1000 * 60 * 60, // Время жизни кэша - 1 час
});


// Initialize logger
const logger = winston.createLogger({
  level: DEEP_LOG ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
      let logMessage = `${timestamp} [${level.toUpperCase()}]: ${message}`;
      if (stack) {
        logMessage += `\n${stack}`;
      }
      return logMessage;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// Initialize LRU Cache
const lruCache = new LRUCache<string, Report>({
  max: 10000,
  maxSize: MAX_CACHE_SIZE_MB * 1024 * 1024, // Convert MB to bytes
  sizeCalculation: (value, key) => JSON.stringify(value).length + key.length,
});

// Global variables
let client: TelegramClient;
let botEntity: Api.InputPeerUser | null = null;
let autoMode = true;
let processingReports: Set<string> = new Set();
let nextCommandTimeout: NodeJS.Timeout | null = null;
let checkNewReportsTimeout: NodeJS.Timeout | null = null;
let undoRange: { start: string; end: string } | null = null;
let isProcessingReports = false;
let redisBatchTimeout: NodeJS.Timeout | null = null;
let redisBatch: Report[] = [];

// Оптимизированная структура для буфера сообщений
const messageBuffer = new Map<number | undefined, BufferItem>();
const sysMessages = new Set<BufferItem>();

// Interfaces and types
interface BufferItem {
  type: 'check' | 'sys';
  content: string;
  reportId?: string;
  timestamp: number;
  mediaHashes?: string[];
  replyTo?: number;
  mediaKey?: string | null;
}

interface Report {
  reportId: string;
  messageContent: string[];
  mediaHashes: string[];
  complaintCount: number;
  source: string;
  sender: string;
  isSpam: number;
  reason?: string;
  timestamp: number;
  decisionSent?: boolean;
  isOpen?: boolean;
  replyTo?: number;
}

type SpamDecision = {
  isSpam: number;
  reason: string;
  checkType: 'fast' | 'gpt' | 'gpt4' | 'default';
};

// Regular expressions
const sysRegex = {
  reportId: /#r(\d+)/,
  complaintCount: /😱(\d+)/,
  source: /^(?:🗣\s*)?Source:\s*(.+)/m,
  sender: /^Sender:\s*(.+)/m,
};

// Utility functions
const log = (message: string, level: 'info' | 'debug' | 'error' | 'warn' = 'info') => {
  if (level === 'debug' && !DEEP_LOG) return;
  
  switch (level) {
    case 'debug':
      logger.debug(message);
      break;
    case 'error':
      logger.error(message);
      break;
    case 'warn':
      logger.warn(message);
      break;
    default:
      logger.info(message);
      break;
  }
};

const logErr = (ctx: string, err: unknown) => {
  const errMsg = err instanceof Error ? err.message : String(err);
  log(`Error in ${ctx}: ${errMsg}`, 'error');
  notify(`Error in ${ctx}: ${errMsg}`).catch(e => 
    log(`Failed to notify admin: ${e instanceof Error ? e.message : String(e)}`, 'error')
  );
};

async function notify(msg: string) {
  try {
    if (!client || !client.connected) {
      await reconnect();
    }
    await client.sendMessage(ADMIN_ID, { message: msg });
    if (DEEP_LOG) log(`Admin notified: ${msg}`, 'debug');
  } catch (error) {
    logErr('notify', error);
  }
}

async function retry<T>(op: () => Promise<T>, maxRetries: number = 3, delay: number = 1000): Promise<T> {
  let lastError: Error | null = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await op();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      log(`Operation failed, retrying in ${delay}ms (${i + 1}/${maxRetries})`, 'debug');
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    }
  }
  throw lastError;
}

// Telegram client functions
async function initClient(): Promise<TelegramClient> {
  if (!API_ID || !API_HASH || !SESSION_STRING) {
    throw new Error('API_ID, API_HASH, and SESSION_STRING must be set in .env file');
  }

  const stringSession = new StringSession(SESSION_STRING);
  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
    retryDelay: 1000,
    useWSS: true,
  });

  try {
    await client.connect();
    log('Client connected successfully', 'info');
    return client;
  } catch (error) {
    logErr('initClient', error);
    throw error;
  }
}

async function initBot() {
  if (!BOT_ID || !BOT_ACCESS_HASH) {
    throw new Error('BOT_ID and BOT_ACCESS_HASH must be set in .env file');
  }

  try {
    botEntity = new Api.InputPeerUser({
      userId: bigInt(BOT_ID),
      accessHash: bigInt(BOT_ACCESS_HASH)
    });
    log('Bot entity initialized successfully', 'info');
  } catch (error) {
    logErr('initBot', error);
    throw error;
  }
}

async function sendToBot(message: string) {
  if (!autoMode) {
    log(`Bot command not sent due to automatic mode being off: ${message}`, 'debug');
    return;
  }

  if (!botEntity) throw new Error('Bot entity not initialized');

  log(`Attempting to send message to bot: ${message}`, 'debug');
  const startTime = Date.now();
  try {
    await retry(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          client.sendMessage(botEntity!, { message });
          resolve();
        }, COMMAND_DELAY);
      });
    });
    const endTime = Date.now();
    const actualDelay = endTime - startTime;

    // Адаптивно корректируем COMMAND_DELAY
    if (actualDelay < COMMAND_DELAY) {
      COMMAND_DELAY = Math.max(COMMAND_DELAY - 10, 50); // Уменьшаем, но не ниже 50 мс
    } else if (actualDelay > COMMAND_DELAY + 100) {
      COMMAND_DELAY += 10; // Увеличиваем, если фактическая задержка значительно больше
    }

    log(`Successfully sent message to bot: ${message}. Actual delay: ${actualDelay}ms`, 'debug');
  } catch (error) {
    logErr(`Failed to send message to bot: ${message}`, error);
    throw error;
  }
}

async function reconnect() {
  try {
    log('Attempting to reconnect Telegram client...', 'info');
    if (client) {
      await client.disconnect();
    }
    client = await initClient();
    await initBot();
    await setupHandlers();
    log('Telegram client reconnected successfully', 'info');
  } catch (error) {
    logErr('reconnect', error);
    throw new Error('Failed to reconnect Telegram client');
  }
}

function getMessageHash(message: string, mediaHashes: string[]): string {
  const content = message + mediaHashes.join(',');
  return createHash('md5').update(content).digest('hex');
}

// Message handling functions
async function handleCheck(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && event.isPrivate && botEntity && message.senderId?.toString() === botEntity.userId.toString()) {
    log(`Received check message: ${message.message}`, 'debug');
    
    const messageContent = message.message || '';
    const mediaHashes: string[] = [];
    let mediaKey: string | null = null;

    if (message.media) {
      const hash = await getHash(message.media);
      mediaHashes.push(hash);
      log(`Media hash: ${hash}`, 'debug');

      if (message.media instanceof Api.MessageMediaPhoto || 
          (message.media instanceof Api.MessageMediaDocument && 
           message.media.document instanceof Api.Document)) {
        const captionText = message.message;
        mediaKey = `media:${message.media instanceof Api.MessageMediaPhoto ? message.media.photo?.id : message.media.document?.id}`;
        log(`Media key generated: ${mediaKey}`, 'debug');
      }
    }

    if (message.replyMarkup) {
      const markupHash = await getHash(message.replyMarkup);
      mediaHashes.push(markupHash);
      log(`Reply markup hash: ${markupHash}`, 'debug');
    }

    const bufferItem: BufferItem = {
      type: 'check',
      content: preprocess(messageContent),
      timestamp: Date.now(),
      mediaHashes,
      replyTo: message.replyTo?.replyToMsgId,
      mediaKey: mediaKey || undefined
    };

    messageBuffer.set(bufferItem.replyTo, bufferItem);
    log(`Message added to buffer. Content: ${bufferItem.content}`, 'debug');
    scheduleProcessing();
  }
}

async function handleSys(event: NewMessageEvent) {
  const { message } = event;
  if (
    message instanceof Api.Message &&
    event.isPrivate &&
    botEntity &&
    message.senderId?.toString() === botEntity.userId.toString()
  ) {
    const messageContent = message.message || '';
    if (messageContent.match(sysRegex.source)) {
      log(`Received system message: ${messageContent}`, 'debug');

      const sysInfo = parseSysMessage(messageContent);
      if (sysInfo.reportId) {
        const sysItem: BufferItem = {
          type: 'sys',
          content: messageContent,
          reportId: sysInfo.reportId,
          timestamp: Date.now(),
          replyTo: message.replyTo?.replyToMsgId
        };
        sysMessages.add(sysItem);
        scheduleProcessing();
      } else {
        log('Received system message without reportId', 'error');
      }
    }
  }
}

async function handleAdd(event: NewMessageEvent) {
  const message = event.message;
  if (
    message instanceof Api.Message &&
    event.isPrivate &&
    botEntity &&
    message.senderId?.toString() === botEntity.userId.toString()
  ) {
    const messageContent = message.message || '';
    if (messageContent.includes("Hello there! Send /next to start processing reports.") ||
        messageContent.includes("Sorry, this action can no longer be undone.")) {
      if (autoMode && !processingReports.has('undos')) {
        await sendToBot("/next 1");
      }
    }
    else if (messageContent.includes("Please select 😡 BAN or 😌 NO.") ||
               messageContent.includes("Sorry, an error has occurred during your request. Please try again later.") ||
               messageContent.includes("No reports found.")) {
      if (!processingReports.has('undos')) {
        await sendToBot("/undo");
      }
    } else if (messageContent.includes("marked as spam 😡") || messageContent.includes("marked as not spam 😌")) {
      const reportIdMatch = messageContent.match(/#r(\d+)/);
      if (reportIdMatch) {
        const reportId = reportIdMatch[1];
        if (isReportInUndoRange(reportId)) {
          processingReports.delete(reportId);
          const cachedReport = lruCache.get(`report:${reportId}`);
          if (cachedReport) {
            const expectedDecision = messageContent.includes("marked as spam 😡") ? 1 : 0;
            if (cachedReport.isSpam !== expectedDecision) {
              const mismatchMessage = `Mismatch in decision for report ${reportId}. Expected: ${expectedDecision}, Actual: ${cachedReport.isSpam}`;
              log(mismatchMessage, 'warn');
              await notify(mismatchMessage);
            }
          }
        } else {
          log(`Ignoring report ${reportId} as it's outside the undo range`, 'debug');
        }
      }
    }
  }
}

function isReportInUndoRange(reportId: string): boolean {
  if (!undoRange) return false;
  const id = BigInt(reportId);
  return id >= BigInt(undoRange.start) && id <= BigInt(undoRange.end);
}

// Оптимизированная функция обработки буфера
async function processBuffer(currentTimestamp: number) {
  log(`Processing buffer at timestamp ${currentTimestamp}`, 'debug');
  
  const startTime = Date.now();
  
  for (const sysMsg of sysMessages) {
    if (sysMsg.timestamp > currentTimestamp) continue;
    
    let matchingCheckMsg = messageBuffer.get(sysMsg.replyTo);
    
    if (!matchingCheckMsg) {
      matchingCheckMsg = Array.from(messageBuffer.values()).find(checkMsg => 
        Math.abs(checkMsg.timestamp - sysMsg.timestamp) < 100
      );
    }

    if (matchingCheckMsg && sysMsg.reportId) {
      // Немедленная обработка отчета вместо использования scheduleDelayedProcessing
      processReport({
        reportId: sysMsg.reportId,
        messageContent: [matchingCheckMsg.content],
        mediaHashes: matchingCheckMsg.mediaHashes || [],
        complaintCount: 0,
        source: '',
        sender: '',
        isSpam: -1,
        timestamp: sysMsg.timestamp,
        replyTo: matchingCheckMsg.replyTo,
        ...parseSysMessage(sysMsg.content)
      }).catch(error => logErr(`Error processing report ${sysMsg.reportId}`, error));
      
      messageBuffer.delete(matchingCheckMsg.replyTo);
    }
    
    sysMessages.delete(sysMsg);
  }

  // Очищаем обработанные сообщения из буфера
  for (const [replyTo, msg] of messageBuffer) {
    if (msg.timestamp <= currentTimestamp) {
      messageBuffer.delete(replyTo);
    }
  }

  const processingTime = Date.now() - startTime;
  updateBufferDelay(processingTime);
}

async function processReport(report: Report): Promise<void> {
  log(`Processing report ${report.reportId}`, 'debug');
  
  resetNextCommandTimer();
  isProcessingReports = true;
  
  if (processingReports.has(report.reportId)) {
    const processingStartTime = await redis.get(`processing_start:${report.reportId}`);
    if (processingStartTime && Date.now() - parseInt(processingStartTime) < MAX_PROCESSING_TIME) {
      log(`Skipping report ${report.reportId}. It's been processing for ${Date.now() - parseInt(processingStartTime)}ms`, 'debug');
      return;
    }
    log(`Report ${report.reportId} processing timeout. Reprocessing.`, 'warn');
  }

  processingReports.add(report.reportId);
  if (redis.status === 'ready') {
    redis.set(`processing_start:${report.reportId}`, Date.now().toString(), 'EX', 600).catch(error => logErr('redis.set', error));
  }
  
  const processingStartTime = Date.now();

  try {
    let decision: SpamDecision | null = null;

    if (!processingReports.has('undos')) {
      const cachedDecision = await checkCache(report.reportId);
      if (cachedDecision && (Date.now() - report.timestamp) < 24 * 60 * 60 * 1000) {
        decision = cachedDecision;
      }
    }

    if (!decision) {
      decision = await fastCheck(report) || await gptCheck(report);
    }

    await applyDecision(report, decision || { isSpam: 0, reason: "No spam detected", checkType: 'default' });

  } catch (error) {
    logErr(`processReport for ${report.reportId}`, error);
  } finally {
    const processingTime = Date.now() - processingStartTime;
    if (processingTime > MAX_PROCESSING_TIME) {
      log(`Processing time exceeded for report ${report.reportId}. Time taken: ${processingTime}ms`, 'warn');
    }
    processingReports.delete(report.reportId);
    if (redis.status === 'ready') {
      redis.del(`processing_start:${report.reportId}`).catch(error => logErr('redis.del', error));
    }
    isProcessingReports = false;
    
    if (processingReports.size === 0 && messageBuffer.size === 0) {
      scheduleNextCommand();
    }
  }
}

async function fastCheck(report: Report): Promise<SpamDecision | null> {
  log(`Starting fast check for report ${report.reportId}`, 'debug');
  
  const hasLinksOrContacts = report.messageContent.some(msg => 
    msg.includes('http') || msg.includes('@') || /\+?\d{10,}/.test(msg)
  );
  
  const dangerousFileExtensions = ['apk', 'exe', 'js', 'bat', 'cmd', 'vbs', 'ps1', 'jar', 'msi', 'com', 'scr', 'pif'];
  const hasDangerousFile = report.mediaHashes.some(hash => 
    dangerousFileExtensions.some(ext => hash.toLowerCase().endsWith(`.${ext}`))
  );
  
  const hasInlineKeyboard = report.mediaHashes.some(hash => 
    hash.startsWith('url_button:') || hash.startsWith('callback_button:') || hash === 'inline_keyboard:generic'
  );
  
  const hasStory = report.mediaHashes.some(hash => hash.startsWith('story:'));
  
  const hasMediaWithComplaints = report.mediaHashes.length > 0 && report.complaintCount > 2;

  if (hasLinksOrContacts || 
      hasDangerousFile || 
      hasInlineKeyboard || 
      hasStory || 
      hasMediaWithComplaints) {
    let reason = "Fast check:";
    if (hasLinksOrContacts) reason += " Links/contacts detected";
    if (hasDangerousFile) reason += " Dangerous file detected";
    if (hasInlineKeyboard) reason += " Inline keyboard detected";
    if (hasStory) reason += " Story detected";
    if (hasMediaWithComplaints) reason += " Media with >2 complaints";

    log(`Fast check detected spam for report ${report.reportId}: ${reason}`, 'debug');
    return { 
      isSpam: 1, 
      reason: reason.trim(), 
      checkType: 'fast'
    };
  }

  log(`Fast check did not detect spam for report ${report.reportId}`, 'debug');
  return null;
}

async function getMediaFromMessage(messageId: number): Promise<Api.TypeMessageMedia | null> {
  try {
    const message = await retry(async () => {
      const messages = await client.getMessages(botEntity!, { ids: [messageId] });
      return messages[0];
    }, 3, 1000);

    if (message && message instanceof Api.Message && message.media) {
      log(`Retrieved media from message ${messageId}`, 'debug');
      return message.media;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('FLOOD_WAIT')) {
      const waitTime = parseInt(error.message.split('_')[2]) || 30;
      log(`FLOOD_WAIT encountered. Waiting for ${waitTime} seconds before retrying.`, 'warn');
      await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
      return getMediaFromMessage(messageId);
    }
    logErr('getMediaFromMessage', error);
  }
  log(`No media found for message ${messageId}`, 'debug');
  return null;
}

async function gptCheck(report: Report): Promise<SpamDecision | null> {
  const messageContent = report.messageContent.join('\n');
  const messageHash = getMessageHash(messageContent, report.mediaHashes);
  const cachedDecision = gptCheckCache.get(messageHash);

  if (cachedDecision) {
    log(`Using cached GPT decision for report ${report.reportId}`, 'debug');
    return cachedDecision;
  }

  log(`Starting GPT check for report ${report.reportId}`, 'debug');

  const gptPrompt = `You are an AI specialized in detecting commercial spam in Telegram groups across any language. Analyze the provided message based on content, context and metadata. Respond with only:
  1 for spam
  0 for not spam
  
**Spam Indicators:**
  - Unsolicited commercial content or subtle marketing
  - Phishing, fake giveaways, unrealistic financial promises
  - Explicit sexual content or coded invitations for sexual services (e.g., "aviliable", "avaible", "свободна", "Скучно? Пиши")
  - Attempts to move conversations to private channels or other platforms
  - Sharing personal information without consent
  - >500 identical symbols or emojis
  - Self-promotion of unrelated channels/groups
  - Cryptocurrency/airdrop mentions with urgent calls to action
  - Any job offers, vacancies, or job postings
  - Multiple links, especially to bots or channels (e.g., "https://t.me/channel", "https://t.me/botbot")
  - Encrypted or coded messages resembling adult content sales (e.g., "CP", "TN", "GV", "TF", "SL", "ID")
  - Requests to write in private messages (e.g., "write + in private")
  - Common spam keywords
  - Sender names containing links or solicitations
  - Higher complaint counts (more than 5)
  
  **Not Spam Indicators:**
  - Normal interactions, casual conversations, jokes (e.g., "haha", "lol", "lmao")
  - Legitimate information sharing, news, educational content
  - Expressive language, including agressive profanity, even if it appears provocative at first glance or very offensive
  - Cultural content, local slang, region-specific discussions
  - Political discussions or criticisms (ecpecially in Russian or Ukrainian)
  - Bot commands (starting with "/"), unless misused (e.g., "/start" or "/help")
  - Warnings about scams or spam (e.g., "Scam", "scamer ni" or similar warnings)
  - Short messages part of ongoing conversations (e.g., short symbols, numbers, emoticons, or phrases - even if they have a high complaint count)
  - Satirical or ironic content (even if it appears provocative at first glance)
  - Controversial opinions without incitement
  - Single-word greetings or short phrases (e.g., "Hi", "Hello", "How are you?")
  - Emotional expressions or outbursts (even if they include profanity or offensive language)
  
  **Context Considerations:**
  - Semantic analysis of meaning and intent
  - Conversation flow and group theme
  - Cultural and linguistic context, sender's country
  - Relevance to ongoing discussions or group activities
  - Complaint counts (not solely relied upon)
  - 'Source' field used for context, not spam evaluation
  
  **REMINDER:** Respond ONLY with 1 or 0. No explanations.
  
  Your analysis:`;
  

  const mediaPrompt = `You are an AI specialized in detecting commercial spam in Telegram groups by analyzing images or media content. Evaluate based on visual elements, embedded text, and context within the group. Respond with only:
  1 for spam
  0 for not spam
  
  **High Priority Indicators:**
  - Unrelated promotional content or advertisements
  - Visuals with unrealistic financial promises or get-rich-quick schemes
  - Sexually explicit or suggestive imagery inappropriate for the group
  - Excessive branding or watermarks from unrelated sources
  - Encouragement to join other groups, channels, or external websites
  - Screenshots promoting specific services or products
  
  **Medium Priority Indicators:**
  - Infographics or charts about cryptocurrency or financial opportunities
  - Images with multiple QR codes or links
  - Visuals out of place with the group's usual content
  - Stock photos or generic imagery commonly used in spam
  - Screenshots of promotional social media posts
  
  **Low Priority Indicators:**
  - Text in a different language than the group's primary language
  - Memes or humorous images potentially masking promotional content
  - Significantly lower or higher quality than typical group content
  
  **Not Spam Indicators:**
  - Legitimate news images or infographics related to the group's theme
  - Personal photos or images consistent with normal interactions
  - Memes, jokes, or satirical content, even if provocative
  - Images with strong language or provocative content relevant to discussions
  - Political or activist imagery, unless violating group rules
  - Artistic or creative content, even if unconventional or shocking
  
  **REMINDER:** Respond ONLY with 1 or 0. No explanations.
  
  Your analysis:`;
  

  const userPrompt = generateUserPrompt(report);

  const textMessages: Array<ChatCompletionMessageParam> = [
    { role: "system", content: gptPrompt },
    { role: "user", content: userPrompt }
  ];

  const mediaMessages: Array<ChatCompletionMessageParam> = [
    { role: "system", content: mediaPrompt },
  ];

  log(`GPT userPrompt for report ${report.reportId}:
  ${userPrompt}`, 'debug');

  try {
    let textDecision: SpamDecision | null = null;
    let mediaDecision: SpamDecision | null = null;

    // Проверка на наличие текстового содержания или только метаданных
    if (report.messageContent.some(content => content.trim() !== '') || (report.sender && report.complaintCount > 0)) {
      const textResponse = await retryGptRequest(async () => {
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: textMessages,
          max_tokens: 10,
          temperature: 0.1,
        });
        updateApiUsage(response.usage?.total_tokens || 0);
        return response;
      });
      
      const textContent = textResponse.choices[0]?.message?.content?.trim();
      if (textContent === '0' || textContent === '1') {
        textDecision = {
          isSpam: Number(textContent),
          reason: Number(textContent) === 1 ? "GPT: spam" : "GPT: not spam",
          checkType: 'gpt'
        };
      } else {
        log(`Unexpected GPT response format for report ${report.reportId}: ${textContent}`, 'warn');
        // If GPT-4o-mini gives an inconclusive response, try with GPT-4o
        const gpt4Response = await retryGptRequest(async () => {
          return openai.chat.completions.create({
            model: "gpt-4-turbo",
            messages: textMessages,
            max_tokens: 10,
            temperature: 0.1,
          });
        });

        const gpt4Content = gpt4Response.choices[0]?.message?.content?.trim();
        if (gpt4Content === '0' || gpt4Content === '1') {
          textDecision = {
            isSpam: Number(gpt4Content),
            reason: Number(gpt4Content) === 1 ? "GPT-4o: spam" : "GPT-4o: not spam",
            checkType: 'gpt4'
          };
        }
      }
    }

    if (ENABLE_GPT_MEDIA_ANALYSIS && report.mediaHashes.length > 0) {
      for (const mediaHash of report.mediaHashes) {
        if (await isGPT4VisionCompatible(mediaHash)) {
          const mediaKey = `media:${mediaHash.split(':')[1]}`;
          const mediaBuffer = await getMediaFromRedis(mediaKey);
          if (mediaBuffer) {
            log(`Sending media content to GPT for report ${report.reportId}, media hash: ${mediaHash}`, 'debug');
            const base64Image = mediaBuffer.toString('base64');
            mediaMessages.push({
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
              ] as ChatCompletionContentPart[]
            });

            const mediaResponse = await retryGptRequest(async () => {
              return openai.chat.completions.create({
                model: "gpt-4o",
                messages: mediaMessages,
                max_tokens: 1,
                temperature: 0.1,
              });
            });

            const mediaContent = mediaResponse.choices[0]?.message?.content?.trim();
            log(`GPT media response for report ${report.reportId}, media hash ${mediaHash}: ${mediaContent}`, 'debug');
            if (mediaContent === '0' || mediaContent === '1') {
              mediaDecision = {
                isSpam: Number(mediaContent),
                reason: `GPT media: ${Number(mediaContent) === 1 ? 'spam' : 'not spam'}`,
                checkType: 'gpt'
              };
              if (mediaDecision.isSpam === 1) {
                break;
              }
            }
          }
        }
      }
    }

    let finalDecision: SpamDecision | null = null;

    if (textDecision && mediaDecision) {
      // If both text and media decisions are available, prefer spam classification
      finalDecision = textDecision.isSpam === 1 || mediaDecision.isSpam === 1 ? 
        (textDecision.isSpam === 1 ? textDecision : mediaDecision) : 
        (textDecision.isSpam === 0 ? textDecision : mediaDecision);
    } else if (textDecision) {
      finalDecision = textDecision;
      log(`GPT text check decision for report ${report.reportId}: ${JSON.stringify(textDecision)}`, 'debug');
    } else if (mediaDecision) {
      finalDecision = mediaDecision;
      log(`GPT media check decision for report ${report.reportId}: ${JSON.stringify(mediaDecision)}`, 'debug');
    }

    // Если решение не было принято, но есть информация о sender и complaintCount
    if (!finalDecision && report.sender && report.complaintCount > 0) {
      const senderAnalysisPrompt = `Analyze the following information for potential spam:
      Sender: ${report.sender}
      Complaint count: ${report.complaintCount}
      
      Consider the sender's name for any indicators of spam (e.g., unusual characters, numbers, or promotional content in the name).
      Factor in the complaint count, but remember it's not definitive proof of spam.
      
      Provide a classification (1 for spam, 0 for not spam).
      Output format: [classification]
      Example: 1 or 0`;

      const senderAnalysisResponse = await retryGptRequest(async () => {
        return openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            { role: "system", content: gptPrompt },
            { role: "user", content: senderAnalysisPrompt }
          ],
          max_tokens: 1,
          temperature: 0.1,
        });
      });

      const senderAnalysisContent = senderAnalysisResponse.choices[0]?.message?.content?.trim();
      if (senderAnalysisContent === '0' || senderAnalysisContent === '1') {
        finalDecision = {
          isSpam: Number(senderAnalysisContent),
          reason: Number(senderAnalysisContent) === 1 ? "GPT sender analysis: potential spam" : "GPT sender analysis: likely not spam",
          checkType: 'gpt'
        };
      }
    }

    if (finalDecision) {
      gptCheckCache.set(messageHash, finalDecision);
      log(`Cached GPT decision for report ${report.reportId}`, 'debug');
      return finalDecision;
    }

    // If no decision was made, log the issue and return null
    log(`GPT check did not make a decision for report ${report.reportId}`, 'warn');
    return null;

  } catch (error) {
    logErr('gptCheck', error);
    log(`GPT check failed for report ${report.reportId}`, 'error');
    throw error;
  }
}

async function retryGptRequest<T>(request: () => Promise<T>, maxRetries: number = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await request();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      log(`GPT request failed, retrying in ${GPT_RETRY_DELAY}ms (${i + 1}/${maxRetries})`, 'warn');
      await new Promise(resolve => setTimeout(resolve, GPT_RETRY_DELAY));
    }
  }
  throw new Error('Max retries reached for GPT request');
}

async function isGPT4VisionCompatible(mediaHash: string): Promise<boolean> {
  const GPT4VisionCompatibleMedia = ['photo', 'sticker', 'gif', 'video', 'videonote'];
  const mediaType = mediaHash.split(':')[0];
  return GPT4VisionCompatibleMedia.includes(mediaType);
}

async function getMediaFromRedis(mediaKey: string): Promise<Buffer | null> {
  try {
    const mediaBase64 = await redis.get(mediaKey);
    if (mediaBase64) {
      log(`Retrieved media from Redis for key: ${mediaKey}`, 'debug');
      return Buffer.from(mediaBase64, 'base64');
    }
  } catch (error) {
    logErr('getMediaFromRedis', error);
  }
  log(`No media found in Redis for key: ${mediaKey}`, 'debug');
  return null;
}

// Helper functions
function preprocess(message: string): string {
  const lines = message.split('\n');
  let processedMessage = lines.slice(1).join('\n').trim();
  
  // Обрезаем сообщение до 1000 символов
  if (processedMessage.length > 1000) {
    processedMessage = processedMessage.substring(0, 997) + '...';
  }
  
  return processedMessage;
}

function updateBufferDelay(processingTime: number) {
  if (processingTime < 100) {
    currentBufferDelay = Math.max(currentBufferDelay - 50, MIN_BUFFER_DELAY);
  } else if (processingTime > 200) {
    currentBufferDelay = Math.min(currentBufferDelay + 50, MAX_BUFFER_DELAY);
  }
}

function scheduleProcessing() {
  setTimeout(() => processBuffer(Date.now()), currentBufferDelay);
}

function parseSysMessage(message: string): Partial<Report> {
  const info: Partial<Report> = {
    complaintCount: 0,
    isSpam: -1,
  };

  const reportIdMatch = message.match(sysRegex.reportId);
  if (reportIdMatch) info.reportId = reportIdMatch[1];

  const complaintMatch = message.match(sysRegex.complaintCount);
  if (complaintMatch) info.complaintCount = parseInt(complaintMatch[1]);

  const sourceMatch = message.match(sysRegex.source);
  if (sourceMatch) info.source = sourceMatch[1].trim();

  const senderMatch = message.match(sysRegex.sender);
  if (senderMatch) info.sender = senderMatch[1].trim();

  return info;
}

function generateUserPrompt(report: Report): string {
  let prompt = "Context:\n";
  prompt += `- Complaint count: ${report.complaintCount}\n`;
  prompt += `- Source: ${report.source}\n`;
  prompt += `- Sender: ${report.sender}\n`;
  
  if (report.mediaHashes.length > 0) {
    prompt += `- Media types present: ${report.mediaHashes.map(hash => hash.split(':')[0]).join(', ')}\n`;
  }

  if (report.messageContent.length > 0) {
    prompt += "\nMessage content:\n";
    prompt += `"""\n${report.messageContent.join('\n')}\n"""`;
  } else {
    prompt += "\nNote: No message content available. Analyzing based on context and metadata.";
  }

  return prompt;
}

async function applyDecision(report: Report, decision: SpamDecision): Promise<void> {
  log(`Applying decision for ${report.reportId}: ${JSON.stringify(decision)}`, 'debug');
  
  if (report.decisionSent && !processingReports.has('undos')) {
    log(`Decision already sent for report ${report.reportId}, skipping`, 'debug');
    return;
  }
  
  await sendDecision(report, decision);
  
  const updatedReport: Report = {
    ...report,
    isSpam: decision.isSpam,
    reason: decision.reason,
    isOpen: false,
    decisionSent: true
  };
  
  await saveCache(updatedReport);
  log(`Updated report saved to cache: ${report.reportId}`, 'debug');
}

async function sendDecision(report: Report, decision: SpamDecision): Promise<void> {
  if (!autoMode && !processingReports.has('undos')) {
    log(`Decision not sent due to automatic mode being off. Report: ${report.reportId}, Decision: ${decision.isSpam ? 'SPAM' : 'NOT SPAM'}`, 'debug');
    return;
  }

  // Apply delay only if the decision is not from GPT
  if (decision.checkType !== 'gpt' && decision.checkType !== 'gpt4') {
    await new Promise(resolve => setTimeout(resolve, COMMAND_DELAY));
  }

  await sendToBot(decision.isSpam ? '😡 SPAM' : '😌 NO');
  log(`Sent decision: ${decision.isSpam ? 'SPAM' : 'NOT SPAM'}`, 'debug');
  report.decisionSent = true;
  await saveCache(report);
  log(`Decision sent for report ${report.reportId}`, 'debug');
}

// Оптимизированные функции кэширования
async function saveCache(report: Report): Promise<void> {
  if (isShuttingDown) return;

  const key = `report:${report.reportId}`;
  lruCache.set(key, report);
  redisBatch.push(report);
  if (redisBatch.length >= 100 || !redisBatchTimeout) {
    saveRedisBatch().catch(error => logErr('saveRedisBatch', error));
  }
  log(`Report ${report.reportId} saved to cache`, 'debug');
}

// Обновите функцию saveRedisBatch
async function saveRedisBatch(): Promise<void> {
  if (isShuttingDown) return;

  if (redisBatchTimeout) {
    clearTimeout(redisBatchTimeout);
  }
  if (redisBatch.length > 0) {
    const batchToSave = [...redisBatch];
    redisBatch = [];
    const pipeline = redis.pipeline();
    for (const report of batchToSave) {
      const key = `report:${report.reportId}`;
      pipeline.set(key, JSON.stringify(report), 'EX', 86400);
    }
    try {
      await pipeline.exec();
      log(`Batch of ${batchToSave.length} reports saved to Redis`, 'debug');
    } catch (error) {
      if (!isShuttingDown) {
        logErr('saveRedisBatch', error);
        // В случае ошибки, возвращаем отчеты обратно в batch
        redisBatch.unshift(...batchToSave);
      }
    }
  }
  if (!isShuttingDown) {
    redisBatchTimeout = setTimeout(() => saveRedisBatch().catch(error => logErr('saveRedisBatch', error)), REDIS_BATCH_INTERVAL);
  }
}

async function checkCache(reportId: string): Promise<SpamDecision | null> {
  if (isShuttingDown) return null;

  try {
    const key = `report:${reportId}`;
    const cachedReport = lruCache.get(key);
    if (cachedReport && cachedReport.isSpam !== -1) {
      log(`LRU cache hit for report ${reportId}`, 'debug');
      return {
        isSpam: cachedReport.isSpam,
        reason: cachedReport.reason || 'Cached decision',
        checkType: 'default'
      };
    }

    if (redis.status === 'ready') {
      const redisReport = await redis.get(key);
      if (redisReport) {
        const parsedReport = JSON.parse(redisReport) as Report;
        if (parsedReport.isSpam !== -1) {
          log(`Redis cache hit for report ${reportId}`, 'debug');
          // Обновляем LRU кэш
          lruCache.set(key, parsedReport);
          return {
            isSpam: parsedReport.isSpam,
            reason: parsedReport.reason || 'Cached decision',
            checkType: 'default'
          };
        }
      }
    }
  } catch (error) {
    if (!isShuttingDown) {
      logErr('checkCache', error);
    }
  }
  return null;
}

async function handleUndosCommand(startReportId?: string, endReportId?: string) {
  if (processingReports.has('undos')) {
    await notify('Undo process is already running.');
    return;
  }

  if (!startReportId || !endReportId) {
    await notify('Please provide both start and end report IDs. Usage: /undos startReportId endReportId');
    return;
  }

  processingReports.add('undos');
  log(`Starting undos process from report ${startReportId} to ${endReportId}`, 'info');

  try {
    undoRange = { start: startReportId, end: endReportId };
    const reportsToUndo = await getReportsBetween(startReportId, endReportId);
    log(`Found ${reportsToUndo.length} reports to undo`, 'info');

    for (const reportId of reportsToUndo) {
      await sendToBot(`/undo${reportId}`);
      log(`Sent undo command for report ${reportId}`, 'debug');

      const undoResponse = await waitForUndoResponse(reportId);
      
      if (undoResponse === 'success') {
        const report = await waitForReport(reportId);
        if (report) {
          await processReport(report);
        } else {
          log(`Failed to receive report ${reportId}`, 'warn');
        }
      } else if (undoResponse === 'toolate') {
        log(`Undo action no longer possible for report ${reportId}`, 'warn');
      }

      // Add a small delay between undo commands to avoid overwhelming the bot
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    logErr(`Error in undo process`, error);
  } finally {
    processingReports.delete('undos');
    undoRange = null;
    log('Undos process completed', 'info');
    await notify('Undos process has been completed.');
  }
}

async function getReportsBetween(startReportId: string, endReportId: string): Promise<string[]> {
  const allKeys = await redis.keys('report:*');
  const sortedKeys = allKeys.sort((a, b) => {
    const aId = BigInt(a.split(':')[1]);
    const bId = BigInt(b.split(':')[1]);
    if (aId < bId) return -1;
    if (aId > bId) return 1;
    return 0;
  });

  const startIndex = sortedKeys.findIndex(key => key.endsWith(`:${startReportId}`));
  const endIndex = sortedKeys.findIndex(key => key.endsWith(`:${endReportId}`));

  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Could not find start or end report in cache`);
  }

  return sortedKeys.slice(startIndex, endIndex + 1).map(key => key.split(':')[1]);
}

async function waitForUndoResponse(reportId: string): Promise<'success' | 'toolate'> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      client.removeEventHandler(checkMessage, new NewMessage({}));
      resolve('toolate');
    }, 5000);  // 5 second timeout

    const checkMessage = (event: NewMessageEvent) => {
      if (event.message instanceof Api.Message && 
          event.message.senderId?.toString() === botEntity?.userId.toString()) {
        const messageText = event.message.message;
        if (messageText?.includes(`Undo action for #r${reportId} completed successfully`)) {
          clearTimeout(timeout);
          client.removeEventHandler(checkMessage, new NewMessage({}));
          resolve('success');
        } else if (messageText?.includes("Sorry, this action can no longer be undone.")) {
          clearTimeout(timeout);
          client.removeEventHandler(checkMessage, new NewMessage({}));
          resolve('toolate');
        }
      }
    };

    client.addEventHandler(checkMessage, new NewMessage({}));
  });
}

async function waitForReport(reportId: string): Promise<Report | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      processingReports.delete(reportId);
      resolve(null);
    }, 10000);  // 10 second timeout

    const checkInterval = setInterval(async () => {
      const cachedReport = await getCachedReport(reportId);
      if (cachedReport && isReportInUndoRange(reportId)) {
        clearTimeout(timeout);
        clearInterval(checkInterval);
        processingReports.delete(reportId);
        resolve(cachedReport);
      }
    }, 500);  // Check every 500ms
  });
}

async function getCachedReport(reportId: string): Promise<Report | null> {
  try {
    const cachedReport = lruCache.get(`report:${reportId}`) || JSON.parse(await redis.get(`report:${reportId}`) || 'null');
    if (cachedReport) {
      // Reset the spam status and reason for re-evaluation
      cachedReport.isSpam = -1;
      cachedReport.reason = undefined;
      return cachedReport;
    }
  } catch (error) {
    logErr('getCachedReport', error);
  }
  return null;
}

async function cleanupCache() {
  try {
    const now = Date.now();
    let deletedCount = 0;

    for (const [key, report] of lruCache.entries()) {
      if (now - report.timestamp > 24 * 60 * 60 * 1000) { // 24 hours
        lruCache.delete(key);
        deletedCount++;
      }
    }

    const redisKeys = await redis.keys('report:*');
    const pipeline = redis.pipeline();
    for (const key of redisKeys) {
      const report = JSON.parse(await redis.get(key) || '{}') as Report;
      if (now - report.timestamp > 24 * 60 * 60 * 1000) {
        pipeline.del(key);
        deletedCount++;
      }
    }
    await pipeline.exec();

    log(`Cleaned up ${deletedCount} old reports from cache`, 'info');
  } catch (error) {
    logErr('cleanupCache', error);
  }
}

async function getCacheSize(): Promise<number> {
  try {
    let totalSize = 0;

    // Подсчет размера LRU кэша
    for (const [key, value] of lruCache.entries()) {
      totalSize += JSON.stringify(value).length + key.length;
    }

    // Подсчет размера Redis кэша только если соединение активно
    if (redis.status === 'ready') {
      const redisKeys = await redis.keys('report:*');
      for (const key of redisKeys) {
        try {
          const size = await redis.memory('USAGE', key);
          if (size !== null) {
            totalSize += size;
          } else {
            log(`Unable to get memory usage for key: ${key}`, 'warn');
          }
        } catch (error) {
          log(`Error getting memory usage for key ${key}: ${error instanceof Error ? error.message : String(error)}`, 'warn');
        }
      }
    } else {
      log('Redis connection is not ready, skipping Redis cache size calculation', 'warn');
    }

    return totalSize / (1024 * 1024); // Convert to MB
  } catch (error) {
    if (isShuttingDown) {
      log('getCacheSize: Application is shutting down, cache size calculation skipped', 'debug');
      return 0;
    }
    logErr('getCacheSize', error);
    return 0;
  }
}

async function limitCacheSize() {
  if (isShuttingDown) {
    log('limitCacheSize: Application is shutting down, cache size limitation skipped', 'debug');
    return;
  }

  try {
    const currentSize = await getCacheSize();
    log(`Current cache size: ${currentSize.toFixed(2)} MB`, 'debug');

    if (currentSize > MAX_CACHE_SIZE_MB) {
      const keysToRemove = Math.ceil((currentSize - MAX_CACHE_SIZE_MB) / 0.1); // Assuming average report size of 0.1 MB
      const lruKeys = Array.from(lruCache.keys()).slice(0, keysToRemove);
      lruKeys.forEach(key => lruCache.delete(key));
      
      if (redis.status === 'ready') {
        const redisKeys = await redis.keys('report:*');
        const oldestKeys = redisKeys.sort().slice(0, keysToRemove);
        
        if (oldestKeys.length > 0) {
          await redis.del(...oldestKeys);
          log(`Removed ${oldestKeys.length} oldest keys from Redis cache`, 'info');
        }
      } else {
        log('Redis connection is not ready, skipping Redis cache cleanup', 'warn');
      }
    }
  } catch (error) {
    logErr('limitCacheSize', error);
  }
}

// Media handling functions
async function getHash(media: Api.TypeMessageMedia | Api.TypeReplyMarkup | null): Promise<string> {
  if (!media) return 'empty';
  
  if (media instanceof Api.MessageMediaEmpty) {
    log('Media type: MessageMediaEmpty', 'debug');
    return 'empty';
  }
  
  if (media instanceof Api.MessageMediaPhoto) {
    log('Media type: MessageMediaPhoto', 'debug');
    return `photo:${media.photo?.id || 'unknown'}`;
  }
  
  if (media instanceof Api.MessageMediaDocument) {
    const document = media.document;
    if (document instanceof Api.Document) {
      const fileType = document.mimeType.split('/')[0];
      const attribute = document.attributes.find(attr => 
        attr instanceof Api.DocumentAttributeSticker ||
        attr instanceof Api.DocumentAttributeAnimated ||
        attr instanceof Api.DocumentAttributeVideo
      );
      
      if (attribute instanceof Api.DocumentAttributeSticker) {
        log('Media type: Sticker', 'debug');
        return `sticker:${document.id}`;
      }
      if (attribute instanceof Api.DocumentAttributeAnimated) {
        log('Media type: GIF', 'debug');
        return `gif:${document.id}`;
      }
      if (attribute instanceof Api.DocumentAttributeVideo) {
        log(`Media type: ${attribute.roundMessage ? 'Video Note' : 'Video'}`, 'debug');
        return attribute.roundMessage ? `videonote:${document.id}` : `video:${document.id}`;
      }
      
      log(`Media type: ${fileType}`, 'debug');
      return `${fileType}:${document.id}`;
    }
  }
  
  if (media instanceof Api.MessageMediaWebPage) {
    log('Media type: MessageMediaWebPage', 'debug');
    if (media.webpage instanceof Api.WebPage) {
      return `webpage:${media.webpage.url}`;
    } else if (media.webpage instanceof Api.WebPageEmpty) {
      return `webpage:empty`;
    } else if (media.webpage instanceof Api.WebPageNotModified) {
      return `webpage:not_modified`;
    }
    return `webpage:unknown`;
  }
  
  if (media instanceof Api.MessageMediaStory) {
    log('Media type: MessageMediaStory', 'debug');
    return `story:${media.id}`;
  }
  
  if (media instanceof Api.ReplyInlineMarkup) {
    log('Media type: ReplyInlineMarkup', 'debug');
    return processInlineMarkup(media);
  }
  
  log(`Unknown media type: ${media.className}`, 'debug');
  return `unknown:${media.className}`;
}

function processInlineMarkup(markup: Api.ReplyInlineMarkup): string {
  for (const row of markup.rows) {
    for (const button of row.buttons) {
      if (button instanceof Api.KeyboardButtonUrl) {
        log(`Inline URL button found: ${button.url}`, 'debug');
        return `url_button:${button.url}`;
      }
      if (button instanceof Api.KeyboardButtonCallback) {
        log('Inline callback button found', 'debug');
        return `callback_button:${button.data.toString('hex')}`;
      }
    }
  }
  return 'inline_keyboard:generic';
}

async function downloadAndStoreMedia(media: Api.TypeMessageMedia, mediaKey: string): Promise<boolean> {
  try {
    if (media instanceof Api.MessageMediaPhoto && media.photo) {
      const buffer = await client.downloadMedia(media);
      if (buffer) {
        await redis.set(mediaKey, buffer.toString('base64'), 'EX', MEDIA_EXPIRY);
        log(`Downloaded and stored photo media: ${mediaKey}`, 'debug');
        return true;
      }
    } else if (media instanceof Api.MessageMediaDocument && media.document) {
      const buffer = await client.downloadMedia(media);
      if (buffer) {
        await redis.set(mediaKey, buffer.toString('base64'), 'EX', MEDIA_EXPIRY);
        log(`Downloaded and stored document media: ${mediaKey}`, 'debug');
        return true;
      }
    }
  } catch (error) {
    logErr('downloadAndStoreMedia', error);
  }
  log(`Failed to download and store media: ${mediaKey}`, 'warn');
  return false;
}

// Next command scheduling
async function scheduleNextCommand() {
  if (nextCommandTimeout) {
    clearTimeout(nextCommandTimeout);
  }
  if (checkNewReportsTimeout) {
    clearTimeout(checkNewReportsTimeout);
  }
  
  // Проверяем, есть ли необработанные отчеты в буфере
  if (messageBuffer.size > 0 || processingReports.size > 0) {
    log('Skipping /next 2 command as there are unprocessed reports', 'debug');
    return;
  }

  nextCommandTimeout = setTimeout(async () => {
    if (autoMode && !isProcessingReports) {
      try {
        log('Sending /next 2 command', 'debug');
        await sendToBot("/undo");
        checkNewReportsTimeout = setTimeout(checkForNewReports, 100000); // 100 секунд
      } catch (error) {
        logErr('Error sending /next 2 command', error);
        await notify('Failed to send /next 2 command. Attempting to recover...');
        await gracefulShutdown();
      }
    } else {
      log('Skipping /next 2 command as reports are being processed', 'debug');
    }
  }, 5000); // 5 seconds delay before sending the next command
}

async function checkForNewReports() {
  if (messageBuffer.size === 0 && processingReports.size === 0) {
    log('No new reports received after /next 2. Restarting application...', 'warn');
    await notify('No new reports received. Restarting application for safety.');
    await gracefulShutdown();
    process.exit(1); // Это вызовет перезапуск приложения на Heroku
  } else {
    log('New reports received and being processed', 'debug');
  }
}

function resetNextCommandTimer() {
  if (nextCommandTimeout) {
    clearTimeout(nextCommandTimeout);
    nextCommandTimeout = null;
  }
  if (checkNewReportsTimeout) {
    clearTimeout(checkNewReportsTimeout);
    checkNewReportsTimeout = null;
  }
  isProcessingReports = true;
  log('Next command timer reset due to ongoing report processing', 'debug');
}

// Admin functions
async function handleAdmin(event: NewMessageEvent) {
  if (!client || !client.connected) {
    log('Telegram client not connected. Attempting to reconnect...', 'debug');
    try {
      await reconnect();
    } catch (error) {
      logErr('handleAdmin - reconnect', error);
      return;
    }
  }

  const message = event.message;
  if (message instanceof Api.Message && message.senderId?.toString() === ADMIN_ID) {
    log(`Received admin message: ${message.message}`, 'debug');
    const commandParts = message.message.toLowerCase().split(' ');
    const command = commandParts[0];

    try {
      switch (command) {
        case '/start':
          autoMode = true;
          await notify('Automatic mode started. Decisions and bot commands will be sent.');
          await scheduleNextCommand();
          break;

        case '/stop':
          autoMode = false;
          await notify('Automatic mode stopped. Decisions and bot commands will not be sent.');
          break;

        case '/status':
          log('Processing /status command', 'debug');
          await sendStatus();
          log('/status command processed', 'debug');
          break;

        case '/undos':
          if (commandParts.length === 3) {
            await handleUndosCommand(commandParts[1], commandParts[2]);
          } else {
            await notify('Invalid undos command. Usage: /undos startReportId endReportId');
          }
          break;

        case '/delay':
          if (commandParts.length === 2) {
            const newDelay = parseInt(commandParts[1]);
            if (!isNaN(newDelay) && newDelay >= 0) {
              PROCESSING_DELAY = newDelay;
              await notify(`Processing delay updated to ${PROCESSING_DELAY} ms`);
            } else {
              await notify('Invalid delay value. Please provide a non-negative integer.');
            }
          } else {
            await notify('Invalid delay command. Usage: /delay [value]');
          }
          break;

        case '/reset':
          await resetRedisCache();
          break;

        case '/db':
          await handleDbCommand();
          break;

        case '/cache':
          await handleCacheCommand();
          break;

        default:
          log(`Unrecognized admin command: ${command}`, 'debug');
          await notify(`Unrecognized command: ${command}. Available commands are:
          /start - Start automatic mode
          /stop - Stop automatic mode
          /status - Get current status
          /undos [startReportId] [endReportId] - Undo and recheck reports in range
          /delay [value] - Set processing delay in milliseconds
          /reset - Clear Redis and LRU caches
          /db - Perform database operations and generate report
          /cache - Get cache info and generate report`);
      }
    } catch (error) {
      logErr(`Error processing admin command: ${command}`, error);
      await notify(`Error processing command ${command}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function updateApiUsage(tokensUsed: number) {
  apiRequestsCount++;
  apiTokensUsed += tokensUsed;
}

async function sendStatus() {
  log('Generating enhanced status report', 'debug');
  try {
    let statusMessage = `
Current status:
Auto mode: ${autoMode ? 'On (decisions and bot commands will be sent)' : 'Off (decisions and bot commands will not be sent)'}
Command delay: ${COMMAND_DELAY} ms

Server Resources:
`;

    // Check server resources
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;

    statusMessage += `CPU Usage: ${os.loadavg()[0].toFixed(2)}%
Memory Usage: ${((usedMemory / totalMemory) * 100).toFixed(2)}%
Free Memory: ${(freeMemory / 1024 / 1024 / 1024).toFixed(2)} GB
Total Memory: ${(totalMemory / 1024 / 1024 / 1024).toFixed(2)} GB

`;

    // Check OpenAI API latency
    const start = Date.now();
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Test" }],
        max_tokens: 1
      });
      const end = Date.now();
      updateApiUsage(response.usage?.total_tokens || 0);
      statusMessage += `OpenAI API latency: ${end - start}ms

`;
    } catch (error) {
      statusMessage += `Error checking OpenAI latency: ${error instanceof Error ? error.message : String(error)}

`;
    }

    // Report API usage
    statusMessage += `OpenAI API Usage:
Requests made: ${apiRequestsCount}
Tokens used: ${apiTokensUsed}
`;

    log('Enhanced status report generated', 'debug');
    await notify(statusMessage);
    log('Enhanced status report sent', 'debug');
  } catch (error) {
    logErr('Error generating enhanced status report', error);
    await notify('Error generating enhanced status report. Please check the logs.');
  }
}

async function resetRedisCache(): Promise<void> {
  try {
    log('Attempting to clear Redis cache...', 'debug');
    await redis.flushdb();
    lruCache.clear();
    log('Redis and LRU caches cleared successfully', 'debug');
    await notify('Redis and LRU caches have been cleared successfully');
  } catch (error) {
    logErr('resetRedisCache', error);
    await notify(`Error clearing caches: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleDbCommand() {
  try {
    log('Handling /db command', 'debug');
    await saveRedisToPostgres();
    const csvFilePath = await generateCsvReport();
    await sendCsvToAdmin(csvFilePath);
    log('DB command executed successfully', 'debug');
    await notify('Database operations completed. CSV report sent.');
  } catch (error) {
    logErr('handleDbCommand', error);
    await notify(`Error executing DB command: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleCacheCommand() {
  try {
    log('Handling /cache command', 'debug');
    const cacheSize = await getCacheSize();
    const cacheContent = await getCacheContent();
    const csvFilePath = await generateCacheCsvReport(cacheContent);
    await sendCsvToAdmin(csvFilePath);
    log('Cache command executed successfully', 'debug');
    await notify(`Cache size: ${cacheSize.toFixed(2)} MB. CSV report of cache content sent.`);
  } catch (error) {
    logErr('handleCacheCommand', error);
    await notify(`Error executing cache command: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function getCacheContent(): Promise<Report[]> {
  const reports: Report[] = [];

  // Get reports from LRU cache
  for (const report of lruCache.values()) {
    reports.push(report);
  }

  // Get reports from Redis
  const keys = await redis.keys('report:*');
  for (const key of keys) {
    const reportData = await redis.get(key);
    if (reportData) {
      reports.push(JSON.parse(reportData) as Report);
    }
  }

  return reports;
}

async function generateCacheCsvReport(reports: Report[]): Promise<string> {
  const csvFilePath = join(tmpdir(), 'cache_report.csv');
  const csvWriter = createObjectCsvWriter({
    path: csvFilePath,
    header: [
      {id: 'reportId', title: 'Report ID'},
      {id: 'isSpam', title: 'Is Spam'},
      {id: 'reason', title: 'Reason'},
      {id: 'timestamp', title: 'Timestamp'},
      {id: 'source', title: 'Source'},
      {id: 'sender', title: 'Sender'},
      {id: 'complaintCount', title: 'Complaint Count'},
      {id: 'messageContent', title: 'Message Content'},
    ]
  });

  const reportData = reports.map(report => ({
    ...report,
    messageContent: report.messageContent.join('\n'), // Join all message content into a single string
  }));

  await csvWriter.writeRecords(reportData);
  log(`Cache CSV report generated: ${csvFilePath}`, 'debug');
  return csvFilePath;
}

// Database functions
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL,
        report_id TEXT NOT NULL,
        message_content TEXT[],
        media_hashes TEXT[],
        complaint_count INTEGER NOT NULL,
        source TEXT NOT NULL,
        sender TEXT NOT NULL,
        is_spam INTEGER,
        reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) PARTITION BY RANGE (created_at);
    `);

    // Add a unique constraint for report_id and created_at
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'unique_report_id_created_at'
        ) THEN
          ALTER TABLE reports ADD CONSTRAINT unique_report_id_created_at UNIQUE (report_id, created_at);
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reports_is_spam_created_at ON reports (is_spam, created_at);
      CREATE INDEX IF NOT EXISTS idx_reports_report_id ON reports (report_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id SERIAL PRIMARY KEY,
        version TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      INSERT INTO schema_version (version)
      SELECT $1
      WHERE NOT EXISTS (SELECT 1 FROM schema_version);
    `, [DB_SCHEMA_VERSION]);

    // Create partitions for the next 12 months
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const startDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const endDate = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
      const partitionName = `reports_y${startDate.getFullYear()}_m${String(startDate.getMonth() + 1).padStart(2, '0')}`;
      
      const partitionExists = await client.query(`
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1 AND n.nspname = 'public'
      `, [partitionName]);

      if (partitionExists.rows.length === 0) {
        const createPartitionQuery = `
          CREATE TABLE IF NOT EXISTS ${partitionName}
          PARTITION OF reports
          FOR VALUES FROM ('${startDate.toISOString()}') TO ('${endDate.toISOString()}');
        `;
        await client.query(createPartitionQuery);
      }
    }

    await client.query('COMMIT');
    log('Database structure updated', 'info');
  } catch (error) {
    await client.query('ROLLBACK');
    logErr('initDB', error);
    throw error;
  } finally {
    client.release();
  }
}

async function saveRedisToPostgres() {
  try {
    log('Starting Redis to PostgreSQL data transfer', 'info');
    const keys = await redis.keys('report:*');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const batchSize = 100;
      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        const reports = await Promise.all(batch.map(key => redis.get(key)));
        
        const values = reports.filter(Boolean).map(reportData => {
          const report = JSON.parse(reportData!) as Report;
          return [
            report.reportId,
            report.messageContent,
            report.mediaHashes,
            report.complaintCount,
            report.source,
            report.sender,
            report.isSpam,
            report.reason,
            new Date(report.timestamp)
          ];
        });

        const query = `
          INSERT INTO reports (report_id, message_content, media_hashes, complaint_count, source, sender, is_spam, reason, created_at)
          VALUES ${values.map((_, index) => `($${index * 9 + 1}, $${index * 9 + 2}, $${index * 9 + 3}, $${index * 9 + 4}, $${index * 9 + 5}, $${index * 9 + 6}, $${index * 9 + 7}, $${index * 9 + 8}, $${index * 9 + 9})`).join(', ')}
          ON CONFLICT (report_id, created_at) DO UPDATE SET
          message_content = EXCLUDED.message_content,
          media_hashes = EXCLUDED.media_hashes,
          complaint_count = EXCLUDED.complaint_count,
          source = EXCLUDED.source,
          sender = EXCLUDED.sender,
          is_spam = EXCLUDED.is_spam,
          reason = EXCLUDED.reason
        `;

        await client.query(query, values.flat());
      }

      await client.query('COMMIT');
      log(`Successfully transferred ${keys.length} reports from Redis to PostgreSQL`, 'info');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    logErr('saveRedisToPostgres', error);
  }
}

async function generateCsvReport(): Promise<string> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT 
        report_id,
        message_content[1] as message,
        complaint_count,
        source,
        sender,
        is_spam,
        reason,
        created_at
      FROM reports
      WHERE created_at >= NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC
    `);

    const csvFilePath = join(tmpdir(), 'spam_report.csv');
    const csvWriter = createObjectCsvWriter({
      path: csvFilePath,
      header: [
        {id: 'report_id', title: 'Report ID'},
        {id: 'message', title: 'Message'},
        {id: 'complaint_count', title: 'Complaint Count'},
        {id: 'source', title: 'Source'},
        {id: 'sender', title: 'Sender'},
        {id: 'is_spam', title: 'Is Spam'},
        {id: 'reason', title: 'Reason'},
        {id: 'created_at', title: 'Created At'}
      ]
    });

    await csvWriter.writeRecords(result.rows);
    log(`CSV report generated: ${csvFilePath}`, 'debug');
    return csvFilePath;
  } catch (error) {
    logErr('generateCsvReport', error);
    throw error;
  } finally {
    client.release();
  }
}

async function sendCsvToAdmin(csvFilePath: string) {
  await client.sendFile(ADMIN_ID, {
    file: csvFilePath,
    caption: 'Here is the latest report.',
    attributes: [
      new Api.DocumentAttributeFilename({ fileName: 'report.csv' })
    ]
  });
  log(`CSV file sent to admin: ${csvFilePath}`, 'debug');
}

async function checkDB(): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT NOW()');
    log(`Database connection successful. Current time: ${result.rows[0].now}`, 'debug');
    return true;
  } catch (error) {
    logErr('checkDB', error);
    return false;
  } finally {
    client.release();
  }
}

// Setup handlers
async function setupHandlers() {
  if (!botEntity) throw new Error('Bot entity not initialized');
  const botUserId = botEntity.userId.toString();

  const handlers = [
    { 
      handler: handleCheck, 
      options: { fromUsers: [botUserId], incoming: true, forwards: true, outgoing: false } 
    },
    { 
      handler: handleSys, 
      options: { fromUsers: [botUserId], incoming: true, forwards: false, outgoing: false, pattern: sysRegex.source } 
    },
    { 
      handler: handleAdmin, 
      options: { fromUsers: [ADMIN_ID], incoming: true, forwards: false, outgoing: false }
    }
  ];

  handlers.forEach(({ handler, options }) => {
    try {
      client.addEventHandler(handler, new NewMessage(options));
      log(`Handler ${handler.name} set up successfully`, 'debug');
    } catch (error) {
      logErr(`setupHandlers - ${handler.name}`, error);
    }
  });

  client.addEventHandler(async (event) => {
    if (event.message instanceof Api.Message &&
        event.message.senderId?.toString() === botUserId &&
        event.message.message &&
        !event.message.message.match(sysRegex.source)) {
      await handleAdd(event);
    }
  }, new NewMessage({ fromUsers: [botUserId], incoming: true, forwards: false, outgoing: false }));
}

// System health check
async function checkSystemHealth() {
  try {
    await redis.ping();
    const dbClient = await pool.connect();
    try {
      await dbClient.query('SELECT 1');
    } finally {
      dbClient.release();
    }
    
    if (!client) {
      throw new Error('Telegram client not initialized');
    }
    
    try {
      await client.getMe();
    } catch (error) {
      throw new Error('Telegram client is not connected');
    }

    log('System health check passed', 'info');
  } catch (error) {
    logErr('System health check failed', error);
    await notify('System health check failed. Attempting restart...');
    process.exit(1);
  }
}

// Cleanup function for old data
async function cleanupOldData() {
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

  // Cleanup LRU Cache
  for (const [key, report] of lruCache.entries()) {
    if (new Date(report.timestamp) < oneMonthAgo) {
      lruCache.delete(key);
    }
  }

  // Cleanup Redis
  const keys = await redis.keys('report:*');
  const pipeline = redis.pipeline();
  for (const key of keys) {
    const report = JSON.parse(await redis.get(key) || '{}') as Report;
    if (new Date(report.timestamp) < oneMonthAgo) {
      pipeline.del(key);
    }
  }
  await pipeline.exec();

  // Cleanup PostgreSQL
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM reports WHERE created_at < $1', [oneMonthAgo]);
    
    const oldPartitions = await client.query(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public' AND tablename LIKE 'reports_y%_m%'
    `);
    
    for (const row of oldPartitions.rows) {
      const partitionDate = new Date(row.tablename.substring(9, 13), parseInt(row.tablename.substring(15)) - 1);
      if (partitionDate < oneMonthAgo) {
        await client.query(`DROP TABLE IF EXISTS ${row.tablename}`);
        log(`Dropped old partition: ${row.tablename}`, 'info');
      }
    }
  } finally {
    client.release();
  }

  log('Cleanup of old data completed', 'info');
}

// Graceful shutdown
async function gracefulShutdown(restart: boolean = false) {
  log(`Starting graceful shutdown... ${restart ? '(Restarting)' : ''}`, 'info');

  autoMode = false;
  await notify(`Automatic mode stopped due to application ${restart ? 'restart' : 'shutdown'}.`);

  // Очистка всех таймеров
  if (nextCommandTimeout) clearTimeout(nextCommandTimeout);
  if (checkNewReportsTimeout) clearTimeout(checkNewReportsTimeout);
  if (redisBatchTimeout) clearTimeout(redisBatchTimeout);

  // Флаг для отслеживания состояния shutdown
  isShuttingDown = true;

  // Функция для безопасного выполнения операций с Redis
  const safeRedisOperation = async (operation: () => Promise<void>) => {
    if (redis.status === 'ready') {
      try {
        await operation();
      } catch (error) {
        logErr('Redis operation during shutdown', error);
      }
    }
  };

  // Сохранение оставшихся отчетов из пакетной обработки
  await safeRedisOperation(async () => {
    if (redisBatch.length > 0) {
      await saveRedisBatch();
    }
  });

  // Закрытие соединения с базой данных
  try {
    await pool.end();
    log('Database connection closed', 'info');
  } catch (error) {
    logErr('gracefulShutdown - closing database connection', error);
  }

  // Отключение клиента Telegram
  try {
    if (client && client.connected) {
      await client.disconnect();
      log('Telegram client disconnected', 'info');
    }
  } catch (error) {
    logErr('gracefulShutdown - disconnecting Telegram client', error);
  }

  // Закрытие соединения с Redis
  try {
    if (redis.status === 'ready') {
      await redis.quit();
      log('Redis connection closed', 'info');
    }
  } catch (error) {
    logErr('gracefulShutdown - closing Redis connection', error);
  }

  log(`Graceful shutdown completed${restart ? ' (Restarting)' : ''}`, 'info');
  await notify(`Application has been ${restart ? 'restarted' : 'shut down'} gracefully.`);

  if (restart) {
    process.exit(1); // Код выхода 1 вызовет перезапуск на Heroku
  } else {
    process.exit(0);
  }
}

// Main function
async function main() {
  try {
    log('Starting application...', 'info');
    try {
      await initDB();
      log('Database initialized successfully', 'info');
    } catch (dbError) {
      logErr('Database initialization failed', dbError);
      throw dbError;
    }

    try {
      await redis.ping();
      log('Successfully connected to Redis', 'info');
    } catch (redisError) {
      logErr('Redis connection failed', redisError);
      throw redisError;
    }

    try {
      client = await initClient();
      await initBot();
      log('Telegram client and bot initialized successfully', 'info');
    } catch (telegramError) {
      logErr('Telegram initialization failed', telegramError);
      throw telegramError;
    }

    try {
      await setupHandlers();
      log('Event handlers set up successfully', 'info');
    } catch (handlersError) {
      logErr('Event handlers setup failed', handlersError);
      throw handlersError;
    }

    app.listen(PORT, () => log(`Server running on port ${PORT}`, 'info'));

    schedule.scheduleJob('0 */2 * * *', saveRedisToPostgres);
    schedule.scheduleJob('*/15 * * * *', checkSystemHealth);
    schedule.scheduleJob('*/5 * * * *', limitCacheSize);
    schedule.scheduleJob('0 2 * * *', cleanupOldData);
    schedule.scheduleJob('*/30 * * * *', cleanupCache);
    log('Periodic tasks scheduled', 'info');

    // Обработчики сигналов завершения работы
    const signalHandler = async (signal: string) => {
      log(`Received ${signal}. Shutting down gracefully`, 'info');
      isShuttingDown = true;
      await gracefulShutdown();
    };

    process.on('SIGINT', () => signalHandler('SIGINT'));
    process.on('SIGTERM', () => signalHandler('SIGTERM'));

    process.on('uncaughtException', async (error) => {
      logErr('Uncaught Exception', error);
      isShuttingDown = true;
      await notify(`Uncaught Exception: ${error.message}. Attempting to recover...`);
      await gracefulShutdown(true);
    });

    process.on('unhandledRejection', async (reason, promise) => {
      logErr('Unhandled Rejection', reason);
      isShuttingDown = true;
      await notify(`Unhandled Rejection: ${reason}. Attempting to recover...`);
      await gracefulShutdown(true);
    });

    log('Application initialized successfully', 'info');
    await notify('Application initialized successfully');
    
    log('Sending initial status report', 'debug');
    await sendStatus();
    log('Initial status report sent', 'debug');

    if (autoMode) {
      log('Starting auto mode', 'info');
      try {
        await sendToBot("/next 0");
        log('Initial "/next 0" command sent successfully', 'debug');
      } catch (error) {
        logErr('Failed to send initial "/next 0" command', error);
        await notify('Failed to start auto mode. Please check the logs and restart if necessary.');
      }
    }

  } catch (error) {
    logErr('main', error);
    await notify(`Application initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Run the application
main().catch(error => {
  logErr('main function', error);
  process.exit(1);
});