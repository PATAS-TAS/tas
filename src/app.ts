import { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { NewMessage, NewMessageEvent } from 'telegram/events/NewMessage.js';
import { StringSession } from 'telegram/sessions/index.js';
import { TelegramClient } from 'telegram/index.js';
import { createObjectCsvWriter } from 'csv-writer';
import { handleFineCommand } from './finetune.js';
import { Api } from 'telegram/tl/index.js';
import { LRUCache } from 'lru-cache';
import schedule from 'node-schedule';
import { createHash } from 'crypto';
import path, { join } from 'path';
import bigInt from "big-integer";
import winston from 'winston';
import express from 'express';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import Redis from 'ioredis';
import { tmpdir } from 'os';
import pkg from 'pg';
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
const REDIS_BATCH_INTERVAL = 10 * 60 * 1000;
const SUSPEND_DURATION = 5 * 60 * 1000;
const MAX_PROCESSING_TIME = 55000;
const MAX_CONSECUTIVE_ERRORS = 5;
const DB_SCHEMA_VERSION = '1.0';
const MAX_CACHE_SIZE_MB = 100;
const GPT_RETRY_DELAY = 10000;
const IDLE_UNDO_DELAY = 45000; // 45 seconds
const MIN_COMMAND_DELAY = 50; // Минимальная задержка между командами в миллисекундах

// Global variables
let autoMode = true;
let apiTokensUsed = 0;
let COMMAND_DELAY = 50;
let apiRequestsCount = 0;
let client: TelegramClient;
let isShuttingDown = false;
let lastDecisionSentTime = 0;
let redisBatch: Report[] = [];
let consecutiveErrorCount = 0;
let isProcessingReports = false;
let noReportsFoundCount: number = 0;
let suspendedUntil: number | null = null;
let idleTimeout: NodeJS.Timeout | null = null;
let botEntity: Api.InputPeerUser | null = null;
let processingReports: Map<string, number> = new Map();
let lastReportProcessTime = Date.now();
let redisBatchTimeout: NodeJS.Timeout | null = null;
let idleResumeTimeout: NodeJS.Timeout | null = null;
let undoRange: { start: string; end: string } | null = null;
let lastCommandSentTime = 0;
let isProcessingScheduled = false;
let isUndoInProgress = false;
let idleUndoTimeout: NodeJS.Timeout | null = null;

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
interface CachedDecision {
  isSpam: number;
  reason: string;
  checkType: 'default' | 'fast' | 'gpt' | 'gpt4' | 'manual';
  reportId: string;
  timestamp: number;
}

const lruCache = new LRUCache<string, CachedDecision>({
  max: 10000,
  ttl: 24 * 60 * 60 * 1000, // 24 hours
  maxSize: MAX_CACHE_SIZE_MB * 1024 * 1024,
  sizeCalculation: (value, key) => JSON.stringify(value).length + key.length,
});

// Optimized structure for message buffer
const messageBuffer: BufferItem[] = [];

// Interfaces and types
interface BufferItem {
  type: 'check' | 'sys';
  content: string[];
  reportId?: string;
  timestamp: number;
  mediaHashes?: string[];
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
  checkType?: 'default' | 'fast' | 'gpt' | 'gpt4' | 'manual';
}

type SpamDecision = {
  isSpam: number;
  reason: string;
  checkType: 'default' | 'fast' | 'gpt' | 'gpt4' | 'manual';
};

// Regular expressions
const sysRegex = {
  reportId: /#r(\d+)/,
  complaintCount: /😱(\d+)/,
  source: /^Source:\s*(.+)/m,
  sender: /^Sender:\s*(.+)/m,
};

// Utility functions
const log = (message: string, level: 'info' | 'debug' | 'error' | 'warn' = 'info') => {
  if (level === 'debug' && !DEEP_LOG) return;
  logger[level](message);
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
    
    const MAX_MESSAGE_LENGTH = 4096;
    
    if (msg.length <= MAX_MESSAGE_LENGTH) {
      await client.sendMessage(ADMIN_ID, { message: msg });
    } else {
      const parts = [];
      for (let i = 0; i < msg.length; i += MAX_MESSAGE_LENGTH) {
        parts.push(msg.slice(i, i + MAX_MESSAGE_LENGTH));
      }
      
      for (let i = 0; i < parts.length; i++) {
        await client.sendMessage(ADMIN_ID, { 
          message: `Part ${i + 1}/${parts.length}:\n${parts[i]}`
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    if (DEEP_LOG) log(`Admin notified: ${msg.substring(0, 100)}...`, 'debug');
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
      delay *= 2;
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

  const currentTime = Date.now();
  const timeSinceLastCommand = currentTime - lastCommandSentTime;

  // Адаптивная задержка
  let adaptiveDelay = Math.max(MIN_COMMAND_DELAY - timeSinceLastCommand, 0);

  if (timeSinceLastCommand < 30) {
    log(`Command sent too quickly (${timeSinceLastCommand}ms) after previous command: ${message}. Stopping application.`, 'error');
    await notify(`Critical error: Command sent too quickly (${timeSinceLastCommand}ms) after previous command: ${message}. Application stopped.`);
    await gracefulShutdown(true);
    return;
  }

  log(`Attempting to send message to bot: ${message}`, 'debug');
  const startTime = Date.now();
  try {
    await retry(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          client.sendMessage(botEntity!, { message });
          resolve();
        }, adaptiveDelay);
      });
    });
    const endTime = Date.now();
    const actualDelay = endTime - startTime;

    if (actualDelay < adaptiveDelay) {
      COMMAND_DELAY = Math.max(COMMAND_DELAY - 10, MIN_COMMAND_DELAY);
    } else if (actualDelay > adaptiveDelay + 100) {
      COMMAND_DELAY += 10;
    }

    lastCommandSentTime = endTime;
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

function getMessageHash(messageContent: string[], sender: string): string {
  const content = messageContent.join('\n') + sender;
  return createHash('md5').update(content).digest('hex');
}

// Message handling functions
async function handleCheck(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && event.isPrivate && botEntity && message.senderId?.toString() === botEntity.userId.toString()) {
    log(`Received check message: ${message.message}`, 'info');
    
    const messageContent = message.message || '';
    const mediaHashes: string[] = [];
    let mediaKey: string | null = null;

    if (message.media) {
      const hash = await getHash(message.media);
      mediaHashes.push(hash);
      log(`Media hash: ${hash}`, 'info');

      if (message.media instanceof Api.MessageMediaPhoto || 
          (message.media instanceof Api.MessageMediaDocument && 
           message.media.document instanceof Api.Document)) {
        mediaKey = `media:${message.media instanceof Api.MessageMediaPhoto ? message.media.photo?.id : message.media.document?.id}`;
        log(`Media key generated: ${mediaKey}`, 'debug');
      }
    }

    if (message.replyMarkup) {
      const markupHash = await getHash(message.replyMarkup);
      mediaHashes.push(markupHash);
      log(`Reply markup hash: ${markupHash}`, 'debug');
    }

    const processedContent = preprocess(messageContent, message.media);

    const bufferItem: BufferItem = {
      type: 'check',
      content: [processedContent],
      timestamp: Date.now(),
      mediaHashes,
      mediaKey: mediaKey || undefined
    };

    messageBuffer.push(bufferItem);
    log(`Check message added to buffer. Content: ${processedContent}`, 'debug');
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
      log(`Received system message: ${messageContent}`, 'info');

      const sysInfo = parseSysMessage(messageContent);
      if (sysInfo.reportId) {
        const bufferItem: BufferItem = {
          type: 'sys',
          content: [messageContent],
          reportId: sysInfo.reportId,
          timestamp: Date.now()
        };

        messageBuffer.push(bufferItem);
        log(`System message added to buffer. ReportId: ${sysInfo.reportId}`, 'debug');
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
    
    if (suspendedUntil !== null && Date.now() < suspendedUntil) {
      log(`System is suspended until ${new Date(suspendedUntil).toISOString()}. Skipping message processing.`, 'warn');
      return;
    }

    if (messageContent.includes("No reports found.")) {
      noReportsFoundCount++;
      log(`Received "No reports found" message. Count: ${noReportsFoundCount}`, 'debug');
      
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      
      idleTimeout = setTimeout(async () => {
        if (Date.now() - lastReportProcessTime > 180000) {
          log('No reports processed for 3 minutes. Entering idle mode.', 'warn');
          await notify('Application entered idle mode due to lack of reports.');
          
          if (idleResumeTimeout) {
            clearTimeout(idleResumeTimeout);
          }
          
          idleResumeTimeout = setTimeout(async () => {
            log('Resuming from idle mode', 'info');
            await notify('Application resuming from idle mode.');
            await sendToBot("/next 4");
          }, 3600000);
        }
      }, 180000);
      resetIdleUndoTimer();
      setTimeout(() => sendToBot("/next"), 50);
    } else if (messageContent.includes("Please select 😡 BAN or 😌 NO.")) {
      noReportsFoundCount = 0;
      lastReportProcessTime = Date.now();
      isProcessingReports = true;
      isUndoInProgress = false;
      resetIdleUndoTimer();
    
      if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = null;
      }
    
      if (idleResumeTimeout) {
        clearTimeout(idleResumeTimeout);
        idleResumeTimeout = null;
      }
    } else if (messageContent.includes("Hello there! Send /next to start processing reports.") ||
               messageContent.includes("Send /next for a new spam report.")) {
      if (autoMode) {
        await sendToBot("/next 5");
      }
      consecutiveErrorCount = 0;
    } else if (messageContent.includes("Sorry, an error has occurred during your request. Please try again later.")) {
      consecutiveErrorCount++;
      log(`Consecutive error count: ${consecutiveErrorCount}`, 'warn');
      
      if (consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
        suspendedUntil = Date.now() + SUSPEND_DURATION;
        log(`System suspended until ${new Date(suspendedUntil).toISOString()} due to consecutive errors`, 'error');
        await notify(`System suspended for ${SUSPEND_DURATION / 60000} minutes due to ${consecutiveErrorCount} consecutive errors.`);
        clearExistingTimers();
        return;
      }

      await undoRecentReports();
    } else if (messageContent.includes("marked as spam 😡") || messageContent.includes("marked as not spam 😌")) {
      lastReportProcessTime = Date.now();
      
      const reportIdMatch = messageContent.match(/#r(\d+)/);
      if (reportIdMatch) {
        const reportId = reportIdMatch[1];
        if (undoRange && isReportInUndoRange(reportId)) {
          processingReports.delete(reportId);
          const cachedDecision = lruCache.get(getMessageHash([messageContent], reportId));
          if (cachedDecision) {
            const expectedDecision = messageContent.includes("marked as spam 😡") ? 1 : 0;
            if (cachedDecision.isSpam !== expectedDecision) {
              const mismatchMessage = `Mismatch in decision for report ${reportId}. Expected: ${expectedDecision}, Actual: ${cachedDecision.isSpam}`;
              log(mismatchMessage, 'warn');
              await notify(mismatchMessage);
            }
          }
        }
      }
      consecutiveErrorCount = 0;
    }
  }
}

async function retryProcessing(reportId: string) {
  log(`Retrying processing for report ${reportId}`, 'info');
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const report = await getReportFromCaches(reportId);
      if (report) {
        await processReport(report);
        log(`Successfully processed report ${reportId} on retry ${i + 1}`, 'info');
        return;
      }
    } catch (error) {
      logErr(`Retry ${i + 1} failed for report ${reportId}`, error);
    }
    await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
  }
  log(`Failed to process report ${reportId} after ${maxRetries} retries`, 'error');
}

async function processBuffer() {
  log('Processing buffer', 'debug');
  
  const currentTime = Date.now();
  const timeThreshold = 30;
  const processingTimeout = 10000;

  const groupedMessages = messageBuffer.reduce((acc, item) => {
    const group = acc.find(g => Math.abs(g[0].timestamp - item.timestamp) <= timeThreshold);
    if (group) {
      group.push(item);
    } else {
      acc.push([item]);
    }
    return acc;
  }, [] as BufferItem[][]);

  for (const group of groupedMessages) {
    const checkMsg = group.find(item => item.type === 'check');
    const sysMsg = group.find(item => item.type === 'sys');

    if (sysMsg && sysMsg.reportId) {
      try {
        if (checkMsg) {
          await Promise.race([
            processReport({
              reportId: sysMsg.reportId,
              messageContent: checkMsg.content,
              mediaHashes: checkMsg.mediaHashes || [],
              complaintCount: 0,
              source: '',
              sender: '',
              isSpam: -1,
              timestamp: checkMsg.timestamp,
              ...parseSysMessage(sysMsg.content[0])
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Processing timeout')), processingTimeout))
          ]);
          log(`Processed full report ${sysMsg.reportId} from buffer`, 'debug');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'Processing timeout') {
          log(`Processing timeout for report ${sysMsg.reportId}`, 'warn');
          await retryProcessing(sysMsg.reportId);
        } else {
          logErr(`Error processing report ${sysMsg.reportId} from buffer`, error);
        }
      }
    } else if (checkMsg) {
      log(`Orphaned check message in buffer, timestamp: ${checkMsg.timestamp}`, 'warn');
    }
  }

  messageBuffer.length = 0;
}

async function processReport(report: Report): Promise<void> {
  log(`Processing report ${report.reportId}`, 'debug');
  resetIdleUndoTimer();
  isProcessingReports = true;
  log(`Started processing report ${report.reportId}`, 'debug');
  
  if (processingReports.has(report.reportId)) {
    const processingStartTime = processingReports.get(report.reportId);
    if (processingStartTime && Date.now() - processingStartTime < MAX_PROCESSING_TIME) {
      log(`Skipping report ${report.reportId}. It's been processing for ${Date.now() - processingStartTime}ms`, 'debug');
      return;
    }
    log(`Report ${report.reportId} processing timeout. Reprocessing.`, 'warn');
  }

  processingReports.set(report.reportId, Date.now());
  
  const processingStartTime = Date.now();

  try {
    let decision: SpamDecision | null = null;

    if (!undoRange) {
      decision = await checkCache(report);
      if (decision) {
        log(`Using cached decision for report ${report.reportId}`, 'debug');
        await applyDecision(report, decision);
        return;
      }
    }

    if (report.messageContent.length === 0) {
      const fullReport = await getReportFromCaches(report.reportId);
      if (fullReport) {
        report = fullReport;
      } else {
        log(`Unable to retrieve full report data for ${report.reportId}`, 'warn');
        return;
      }
    }

    decision = await fastCheck(report) || await gptCheck(report);

    if (!decision) {
      log(`All checks returned null for report ${report.reportId}. Marking as spam.`, 'warn');
      decision = { isSpam: 1, reason: "All checks inconclusive, defaulting to spam", checkType: 'default' };
    }

    await applyDecision(report, decision);
    await saveCache(report, decision);

    // Сохраняем в Redis только если решение не из кэша
    if (decision.checkType !== 'default') {
      await saveReportToRedis(report);
    }

  } catch (error) {
    logErr(`processReport for ${report.reportId}`, error);
  } finally {
    const processingTime = Date.now() - processingStartTime;
    if (processingTime > MAX_PROCESSING_TIME) {
      log(`Processing time exceeded for report ${report.reportId}. Time taken: ${processingTime}ms`, 'warn');
    }
    processingReports.delete(report.reportId);
    isProcessingReports = processingReports.size > 0;
    log(`Finished processing report ${report.reportId}`, 'debug');
    resetIdleUndoTimer();
  }
}

async function fastCheck(report: Report): Promise<SpamDecision | null> {
  log(`Starting fast check for report ${report.reportId}`, 'debug');
  
  const urlRegex = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*)/gi;
  const usernameRegex = /@[a-zA-Z0-9_]{5,}/g;
  const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
  
  const hasLinksOrUsernames = report.messageContent.some(msg => 
    urlRegex.test(msg) || usernameRegex.test(msg)
  );
  
  const excessiveEmoji = report.messageContent.some(msg => {
    const emojiCount = (msg.match(emojiRegex) || []).length;
    return emojiCount > 50;
  });
  
  const dangerousFileTypes = ['application/x-msdownload', 'application/x-executable', 'application/javascript', 'application/x-bat', 'application/x-msdos-program', 'application/x-vbs', 'application/x-powershell', 'application/java-archive', 'application/x-ms-installer', 'application/x-ms-shortcut', 'application/x-ms-dos-executable'];
  const hasDangerousFile = report.mediaHashes.some(hash => {
    const fileType = getFileTypeFromHash(hash);
    return dangerousFileTypes.includes(fileType.toLowerCase());
  });
  
  const hasInlineKeyboard = report.mediaHashes.some(hash => 
    hash.startsWith('url_button:') || hash.startsWith('callback_button:') || hash === 'inline_keyboard:generic'
  );
  
  const hasStory = report.mediaHashes.some(hash => hash.startsWith('story:'));
  
  const hasPhotoOrVideoWithComplaints = report.mediaHashes.some(hash => {
    const mediaType = hash.split(':')[0];
    return (mediaType === 'photo' || mediaType === 'video') && report.complaintCount > 1;
  });

  const hasOtherMediaWithComplaints = report.mediaHashes.some(hash => {
    const mediaType = hash.split(':')[0];
    return (mediaType !== 'photo' && mediaType !== 'video') && report.complaintCount > 2;
  });

  const hasLinksOrUsernamesWithComplaints = hasLinksOrUsernames && report.complaintCount > 2;

  const repeatedContent = report.messageContent.some(msg => {
    const words = msg.split(/\s+/);
    return words.some((word, index, array) => 
      word.length > 1 && array.filter(w => w === word).length > 10
    );
  });

  const suspiciousKeywords = ['casino', 'bet', 'gambling', 'lottery', 'prize', 'winner', 'jackpot', 'earn money', 'make money', 'get rich', 'investment opportunity'];
  const hasSuspiciousKeywords = report.messageContent.some(msg => 
    suspiciousKeywords.some(keyword => msg.toLowerCase().includes(keyword))
  );

  if (hasPhotoOrVideoWithComplaints || 
      hasOtherMediaWithComplaints || 
      hasLinksOrUsernamesWithComplaints || 
      hasDangerousFile || 
      hasInlineKeyboard || 
      hasStory || 
      excessiveEmoji ||
      repeatedContent ||
      hasSuspiciousKeywords) {
    let reason = "Fast check:";
    if (hasPhotoOrVideoWithComplaints) reason += " Photo/video with >1 complaint";
    if (hasOtherMediaWithComplaints) reason += " Other media with >2 complaints";
    if (hasLinksOrUsernamesWithComplaints) reason += " Links/usernames with >2 complaints";
    if (hasDangerousFile) reason += " Dangerous file detected";
    if (hasInlineKeyboard) reason += " Inline keyboard detected";
    if (hasStory) reason += " Story detected";
    if (excessiveEmoji) reason += " Excessive use of emoji";
    if (repeatedContent) reason += " Repeated content detected";
    if (hasSuspiciousKeywords) reason += " Suspicious keywords detected";

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

function getFileTypeFromHash(hash: string): string {
  const [mediaType, fileId] = hash.split(':');
  if (mediaType === 'document') {
    return fileId.split('.').pop() || '';
  }
  return mediaType;
}

async function gptCheck(report: Report): Promise<SpamDecision | null> {
  log(`Starting GPT check for report ${report.reportId}`, 'debug');

  const gptPrompt = `You are an advanced AI specialized in detecting commercial spam in Telegram groups across any language. Your task is to analyze the provided message along with its metadata and context to determine whether it is spam. Respond ONLY with:
  1 for spam
  0 for not spam
  
  **Input Structure:**
  - **Message:** The content of the message to analyze.
  - **Source:** The name of the group where the message was sent.
  - **Sender:** The name or nickname of the sender. Emoji flags indicate the sender's country.
  - **Complaints:** The number of complaints the message has received.
  
  **Special Note on "Inline Title":**
  If you see a line starting with "Inline Title:" in the message content, it indicates the title of an embedded webpage or media (like a YouTube video) shared in the message. This title is often clickbait or misleading in spam messages. Pay extra attention to these titles, especially if they promise easy money, quick earnings, or seem overly sensational.

  **Spam Classification Criteria:**
  
  1. **Content-Based Indicators:**
     - **Commercial and Financial Offers:**
       - ANY sale, promotion, vacancies, employment postings, part-time work, household tasks, job offer, or service provision, regardless of context or type.
       - ANY requests for services, including pet-sitting, house-sitting, or other personal assistance, especially if mentioning payment.
       - ANY requests for help with tasks like loading/unloading, delivery, or any other work promising payment.
       - Unsolicited marketing or promotional content for any product or service.
       - Investment opportunities, especially those promising high returns.
       - Phishing attempts, fake giveaways, or unrealistic financial promises.
       - Mentions of cryptocurrencies, airdrops, or similar financial schemes. (e.g., "0.1trx转账一次", "$100usdt兑换", etc.)
       - Offers of work-from-home or remote job opportunities with high earnings potential.
       - Specific earnings claims (e.g., "earn $1000 daily", "100$ в день", etc.).
       - Mentions of financial incentives tied to minimal effort.
       - Suspicious percentage returns (e.g., "23.450% за сутки").
       - Claims of "free" services combined with financial or investment themes.
       - Contests or giveaways promoting products or services.
       - Asks to write in private messages for product inquiries or purchases.
       - Offers to borrow money or financial assistance.
       - Invitations to join some activities.
       - ANY requests to top up a phone balance.
       - ANY requests for donations for medical treatment.
     - **Job Offers and Temporary Work:**
       - Any messages offering temporary work, part-time jobs, or quick earning opportunities, regardless of the group's theme.
       - Requests for help with tasks like loading/unloading, delivery, pet-sitting, house-sitting, or any other work promising payment.
       - Messages seeking someone to perform a service, even if it seems legitimate (e.g., pet-sitting, apartment checking).
     - **E-commerce and Social Media Promotion:**
       - Offers for SEO services, advertising setup, or product analytics.
       - Promises to increase sales or visibility on platforms like WB, Ozon, Amazon, etc.
       - Offers for account management or "full maintenance" of online stores.
       - Claims of expertise in e-commerce platforms or social media marketing.
       - Mentions of "cases" or "portfolios" in profile descriptions.
       - Unsolicited offers to improve search rankings or "get to the top".
     - **Product Descriptions and Catalogs:**
       - Detailed product descriptions with prices.
       - Links or references to online catalogs or marketplaces.
       - Use of common e-commerce terms like "in stock", "limited quantity", or "order now".
     - **Discount and Sale Announcements:**
       - Messages primarily focused on announcing sales, discounts, or special offers.
       - Time-limited promotional offers for any products or services.
     - **Referral and Affiliate Marketing:**
       - Encouragement to use referral codes or links for purchases.
       - Affiliate marketing messages for any products or platforms.
     - **Sexual Content:**
       - Explicit sexual content or coded invitations for sexual services. (e.g., "Open vcs", "Meet up", "Meet now", "встречусь", "available", "Content available", "avaible", "свободна", "Скучно? Пиши", etc.)
       - Offers of adult or escort services, even if indirect. (e.g. "проведем эту ночь вместе", "ищу мужчину", "Работаю❤️", "Men should message me", etc.)
       - Encrypted or coded messages resembling adult content sales. (e.g. "Ready vcs", "CP", "TN", "GV", "TF", "SL", "ID", "SVC", etc. - in any register)
     - **Excessive Links and URLs:**
       - Presence of multiple links (more than 1) in a single message.
       - Use of URL shorteners or suspicious domains.
       - Referral links containing parameters like "ref_" or "startapp=".
     - **Obfuscated Text and Symbols:**
       - Use of numbers or symbols to replace letters (e.g., "h3ll0" instead of "hello", or "kaнᴀⲗ" instead of "канал", etc.).
       - Excessive use of emojis or repetitive symbols (>10).
       - Obfuscated or intentionally misspelled keywords related to spam or sales.
     - **Urgency and Incentives:**
       - Phrases that create a sense of urgency (e.g., "hurry", "limited time offer", etc.).
       - Promises of bonuses, gifts, or free items as incentives for purchases.
     - **Legitimacy Claims:**
       - Unverified claims of official partnerships or endorsements.
       - References to support or admins to legitimize offers.
       - Phrases like "no bugs", "legit", or "trusted" to appear legitimate.
     - **Group or Channel Promotion:**
       - Repeated mentions of Telegram channels or groups, especially if combined with commercial themes.
       - Invitations to join other groups or channels for shopping or financial opportunities.
     - **Social Media Promotion Services:**
       - Offers to boost OnlyFans, Fansly, or other social media accounts.
       - Promises of increased traffic or followers for commercial purposes.
     - **Urgency and Exclusivity:**
       - Phrases like "LIMITED SPOTS", "Limited Availability", "SECURE YOUR SPOT" related to product sales.
       - Claims of time-sensitive offers or deals.
     - **Excessive Use of Emojis and Capital Letters:**
       - Messages with an unusually high number of emojis (>5 per sentence), especially in product descriptions.
       - Extensive use of capital letters for emphasis in promotional content.
     - **Fake Official Notifications:**
       - Messages imitating official notifications from banks, government agencies, or other organizations, especially if they involve transactions or purchases.
     - **Pattern-Based Spam:**
       - Messages consisting primarily of repetitive patterns of emojis or symbols, often used in product listings.
       - Repetition of the same message or key phrases related to sales or promotions.
       - Numbered lists of steps for joining, investing, or purchasing.
     - **Illegal Services and Documents:**
       - Offers to provide or assist in obtaining official documents through unofficial means.
       - Mentions of bypassing official procedures or databases for commercial gain.
       - Offers related to fake or forged documents, especially if tied to financial transactions.
     - **Job Offers and Temporary Work:**
       - Any messages offering temporary work, part-time jobs, or quick earning opportunities, regardless of the group's theme.
       - Requests for help with tasks like loading/unloading, delivery, or any other work promising payment.
     - **Repetitive Symbols:**
       - Messages containing repeated patterns of symbols or emojis, such as "🔤🔤🔤🔤🔤".
     - **Short Messages with Spam Indicators:**
       - Brief messages like "Пиши", "Готов?", "Интересно?", especially when followed by emojis, should be considered potential spam if the context is suspicious.
       - Short phrases that imply availability for services, especially in dating or adult-themed groups.
     - **Voting or Engagement Requests:**
       - Messages asking for votes or engagement for commercial or promotional purposes, e.g., "🚀 Vote for the Best Social Enterprise Project! 🚀"
     - **Links to External Profiles:**
       - Messages containing links to external profiles or channels, especially if they seem promotional, e.g., "下面好痒 @Xiaojiujiubaoyang_7 (https://t.me/Xiaojiujiubaoyang_7)"
     - **Unsolicited Feedback Requests:**
       - Messages asking for feedback or reviews on external content, especially if accompanied by links.
       - Requests for comments or input on documents, articles, or other materials hosted on external platforms.
     - **News or Information Sharing with Links:**
       - Messages sharing news or information that include links to external websites, especially if the content seems unrelated to the group's theme.
       - Announcements of events, competitions, or opportunities that direct users to external websites for more information or registration.
    
  2. **Context-Based Indicators:**
     - **Sender Analysis:**
       - Sender names or nicknames containing spam-specific patterns or keywords related to sales or marketing.
       - For very short messages, pay extra attention to the sender's name for commercial indicators.
     - **Complaint Counts:**
       - Messages with an extremely high number of complaints (e.g., >50) should be closely evaluated, but not automatically classified as spam.
       - Messages with more than 2 complaints and containing phone numbers are likely spam.
       - Consider the overall context and content of the message, regardless of complaint count.
     - **Message Length:**
       - Very short messages (less than 5 words) without spam indicators are typically not spam.
       - Combine excessive emojis with commercial offers are more likely to be spam.
     - **Relevance to Group:**
       - Are out of context with the group's theme or ongoing discussions, especially if they introduce commercial content.
       - Abruptly change the topic to product offers or job postings.
     - **Source Group Analysis:**
       - Consider the nature of the group where the message was posted. Groups with names suggesting spam, hacking, or illicit activities should increase suspicion of commercial spam.
     - **Multiple Indicators:**
       - Combine commercial offers, promises of quick gains, and calls for urgent action are highly likely to be spam.
     - **Inline Titles:**
       - Pay special attention to inline titles, especially if they align with common spam tactics like promising easy money, quick earnings, or seem overly sensational.
  
  3. **Not Spam Indicators:**
     - **Normal Communication:**
       - Casual conversations, jokes, memes, and personal interactions without commercial intent.
       - Short expressions of gratitude (e.g., "Thanks!", "Great job", etc.).
       - Legitimate information sharing, news, or educational content without promotional elements.
     - **Expressive Language:**
       - Use of profanity, insults, or offensive language, even if aggressive or vulgar, unless combined with commercial content.
       - Emotional expressions or outbursts without sales pitches.
       - Use of nationalistic or racist language, even if it's not related to commercial content. Or if it's just a joke or symbols (e.g., "卍卍卍" (if this symbol not used more 200 times in a single message)).
     - **Cultural and Contextual Content:**
       - Local slang, cultural references, or region-specific discussions without commercial elements.
       - Political discussions or criticisms, even if controversial or using strong language.
     - **Functional Messages:**
       - Bot commands (starting with "/", e.g., "/start", "/help" or "/start@AdmiinLyLy_bot", etc.) - if they have less than 3 complaints.
       - Warnings about scams or spam.
       - Satirical, ironic, or controversial opinions without commercial intent.
     - **Greetings and Updates:**
       - Simple greetings or short phrases in any language (e.g., "Hello", "Привет", "Yoo", "ЫЭЫЭЫХЫХЫ", etc.).
       - Short informational updates about group activities or moderation.
       - Messages referring to previous conversations or ongoing discussions without sales elements.
     - **Cryptocurrency and Financial Discussions:**
       - Legitimate discussions about cryptocurrency prices, market trends, or trading strategies without promotional content.
       - Sharing of cryptocurrency wallet addresses without spam indicators. (e.g., "0x123456789...", "UQA-aBE6_uNKRUCXdsh...", etc.)
     - **Numerical Formats:**
       - Standard numerical formats like "$500,000.00" are not inherently spam unless accompanied by suspicious claims or offers.
  
  **Instructions:**
  - Analyze based on above indicators
  - Consider sender's name for spam patterns (ignore @usernames)
  - Ensure multi-language support
  - For very short messages, consider full context (sender's name)
  - Messages offering temporary work or quick earning opportunities should always be classified as spam, regardless of the group's theme.
  - Cryptocurrency wallet addresses alone are not spam, but be cautious if they're accompanied by promotional content.
  - Bot commands and slash (/) messages are generally not spam unless they contain explicit promotional content.
  - Messages with repetitive symbol patterns like "🔤🔤🔤🔤🔤" should be considered spam.
  - Short, vague messages that could be interpreted as invitations for commercial or adult services should be carefully evaluated in context.
  - Mark hi/hello messages as NOT spam virtually always, regardless of the complaint count. However, if you encounter a short message with emojis like 💋❤️ and similar, and it's obvious that the sender is there to offer sexual services (judging from the sender name) in a non-adult chat (based on the source name), then mark it as SPAM.
  - If the message indicates that there are more than 1 channel link (e.g., "Channel links: >1"), it's likely spam.
  - Pay close attention to "Inline Title" information, as it often reveals the true nature of shared links or media, especially in cases of clickbait or misleading content.
  
  **REMINDER:** 
  - Do not consider the 'Source' field as definitive; it is only for contextual information.
  - Ignore the sender's nickname unless it contains spam-specific patterns.
  - High complaint counts alone do not automatically indicate spam. Always consider the full context and content of the message.
  - Short, casual greetings are typically not spam, but consider the full context, especially if the source or sender name suggests spam-related activities.
  - Messages promoting social media services or any kind of product, especially with promises of quick gains and urgent calls to action, are very likely to be spam.
  - Legitimate discussions about cryptocurrencies or sharing of wallet addresses without promotional content are not spam.
  - Any offers of part-time work, temporary jobs, or requests for paid help should be classified as spam.
  - Be cautious with short, ambiguous messages that could be interpreted as solicitations, especially in groups with adult or dating themes.
  - "Inline Title" information can be crucial in identifying spam, especially for shared links or media with misleading titles.
  
  **Respond ONLY with number 1 (for spam) or 0 (for not spam), without any explanations.**
  **Your analysis:**
  `;

  const userPrompt = generateUserPrompt(report);

  const messages: Array<ChatCompletionMessageParam> = [
    { role: "system", content: gptPrompt },
    { role: "user", content: userPrompt }
  ];

  try {
    const response = await retryGptRequest(async () => {
      return openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messages,
        max_tokens: 1,
        temperature: 0.1,
      });
    });
    
    updateApiUsage(response.usage?.total_tokens || 0);
    
    const decision = response.choices[0]?.message?.content?.trim();
    
    if (decision === '0' || decision === '1') {
      return {
        isSpam: Number(decision),
        reason: Number(decision) === 1 ? "GPT: spam" : "GPT: not spam",
        checkType: 'gpt'
      };
    }

    log(`Unexpected GPT response for report ${report.reportId}: ${decision}`, 'warn');
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

// Helper functions
function preprocess(message: string, media?: Api.TypeMessageMedia): string {
  const lines = message.split('\n');
  let processedMessage = lines.slice(1).join('\n').trim();
  
  if (media instanceof Api.MessageMediaWebPage && media.webpage instanceof Api.WebPage) {
    const webpage = media.webpage;
    if (webpage.title) {
      processedMessage = `Inline Title: ${webpage.title}\n\n${processedMessage}`;
    }
  }
  
  if (processedMessage.length > 1000) {
    processedMessage = processedMessage.substring(0, 997) + '...';
  }
  
  return processedMessage;
}

function scheduleProcessing() {
  if (!isProcessingScheduled) {
    isProcessingScheduled = true;
    setImmediate(() => {
      processBuffer();
      isProcessingScheduled = false;
    });
  }
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
  
  if (report.decisionSent && !undoRange) {
    log(`Decision already sent for report ${report.reportId}, skipping`, 'debug');
    return;
  }
  
  const updatedReport: Report = {
    ...report,
    isSpam: decision.isSpam,
    reason: decision.reason,
    isOpen: false,
    decisionSent: autoMode
  };
  
  if (autoMode) {
    await sendDecision(updatedReport, decision);
  } else {
    log(`Decision for report ${report.reportId} processed but not sent (autoMode off): ${decision.isSpam ? 'SPAM' : 'NOT SPAM'}`, 'info');
  }
  
  await saveReportToRedis(updatedReport);
  log(`Updated report saved to Redis: ${report.reportId}`, 'debug');

  messageBuffer.length = 0;
  log('Buffer cleared after decision processed', 'debug');
}

async function sendDecision(report: Report, decision: SpamDecision): Promise<void> {
  if (!autoMode && !undoRange) {
    log(`Decision not sent due to automatic mode being off. Report: ${report.reportId}, Decision: ${decision.isSpam ? 'SPAM' : 'NOT SPAM'}`, 'debug');
    return;
  }

  const currentTime = Date.now();
  const timeSinceLastDecision = currentTime - lastDecisionSentTime;

  if (timeSinceLastDecision < 30) {
    log(`Decision sent too quickly (${timeSinceLastDecision}ms) after previous decision for report ${report.reportId}. Stopping application.`, 'error');
    await notify(`Critical error: Decision sent too quickly (${timeSinceLastDecision}ms) after previous decision for report ${report.reportId}. Application stopped.`);
    await gracefulShutdown(true);
    return;
  }

  try {
    await sendToBot(decision.isSpam ? '😡 SPAM' : '😌 NO');
    lastDecisionSentTime = Date.now();

    log(`Sent decision: ${decision.isSpam ? 'SPAM' : 'NOT SPAM'}`, 'info');
    report.decisionSent = true;
    await saveReportToRedis(report);
    log(`Decision sent for report ${report.reportId}`, 'debug');
  } catch (error) {
    logErr(`Error sending decision for report ${report.reportId}`, error);
    throw error;
  }
}

async function saveCache(report: Report, decision: SpamDecision): Promise<void> {
  if (isShuttingDown) return;

  const messageHash = getMessageHash(report.messageContent, report.sender);
  const cachedDecision: CachedDecision = {
    isSpam: decision.isSpam,
    reason: decision.reason,
    checkType: decision.checkType,
    reportId: report.reportId,
    timestamp: Date.now()
  };
  lruCache.set(messageHash, cachedDecision);
  log(`Decision cached for report ${report.reportId}`, 'debug');
}

async function saveReportToRedis(report: Report): Promise<void> {
  if (isShuttingDown) return;

  if (report.isSpam === -1) {
    log(`Skipping save for report ${report.reportId} with isSpam === -1`, 'debug');
    return;
  }

  // Проверяем, не является ли отчет результатом обработки LRU кэша
  if (report.checkType === 'default') {
    log(`Skipping save for report ${report.reportId} from LRU cache`, 'debug');
    return;
  }

  const key = `report:${report.reportId}`;
  redisBatch.push(report);
  
  if (redisBatch.length >= 100) {
    await saveRedisBatch();
  }
  
  log(`Report ${report.reportId} saved to Redis batch`, 'debug');
}

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
        redisBatch.unshift(...batchToSave);
      }
    }
  }
  if (!isShuttingDown) {
    redisBatchTimeout = setTimeout(() => saveRedisBatch().catch(error => logErr('saveRedisBatch', error)), REDIS_BATCH_INTERVAL);
  }
}

async function checkStuckReports() {
  const stuckReportIds = await getStuckReportIds();
  for (const reportId of stuckReportIds) {
    await retryProcessing(reportId);
  }
}

async function getStuckReportIds(): Promise<string[]> {
  const currentTime = Date.now();
  const stuckThreshold = 5 * 60 * 1000; // 5 minutes
  const stuckReportIds: string[] = [];

  for (const [reportId, startTime] of processingReports.entries()) {
    if (currentTime - startTime > stuckThreshold) {
      stuckReportIds.push(reportId);
    }
  }

  return stuckReportIds;
}

async function checkCache(report: Report): Promise<SpamDecision | null> {
  if (isShuttingDown) return null;

  try {
    const messageHash = getMessageHash(report.messageContent, report.sender);
    let cachedDecision = lruCache.get(messageHash);
    
    if (!cachedDecision && report.messageContent.join('').length > 500) {
      const redisKey = `cache:${messageHash}`;
      const redisDecision = await redis.get(redisKey);
      if (redisDecision) {
        cachedDecision = JSON.parse(redisDecision) as CachedDecision;
        lruCache.set(messageHash, cachedDecision);
      }
    }

    if (cachedDecision && (cachedDecision.isSpam === 0 || cachedDecision.isSpam === 1)) {
      log(`Cache hit for report ${report.reportId}`, 'debug');
      return {
        isSpam: cachedDecision.isSpam,
        reason: cachedDecision.reason,
        checkType: cachedDecision.checkType
      };
    }
  } catch (error) {
    if (!isShuttingDown) {
      logErr('checkCache', error);
    }
  }
  return null;
}

async function handleUndosCommand(startReportId?: string, endReportId?: string) {
  if (undoRange) {
    await notify('Undo process is already running.');
    return;
  }

  if (!startReportId || !endReportId) {
    await notify('Please provide both start and end report IDs. Usage: /undos startReportId endReportId');
    return;
  }

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

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    logErr(`Error in undo process`, error);
  } finally {
    undoRange = null;
    log('Undos process completed', 'info');
    await notify('Undos process has been completed.');
  }
}

async function getReportsBetween(startReportId: string, endReportId: string): Promise<string[]> {
  const startId = BigInt(startReportId);
  const endId = BigInt(endReportId);

  const lruReports = Array.from(lruCache.values())
    .filter(decision => {
      const reportId = BigInt(decision.reportId);
      return reportId >= startId && reportId <= endId;
    })
    .map(decision => decision.reportId);

  const redisKeys = await redis.keys('report:*');
  const redisReports = (await Promise.all(redisKeys.map(async key => {
    const reportId = key.split(':')[1];
    if (lruReports.includes(reportId)) {
      return null;
    }
    const report = JSON.parse(await redis.get(key) || '{}') as Report;
    const id = BigInt(report.reportId);
    return (id >= startId && id <= endId) ? report.reportId : null;
  }))).filter((id): id is string => id !== null);

  return [...new Set([...lruReports, ...redisReports])].sort((a, b) => {
    const aId = BigInt(a);
    const bId = BigInt(b);
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}

async function handleRedisCommand() {
  try {
    log('Handling /redis command', 'debug');
    const redisContent = await getRedisContent();
    const csvFilePath = await generateRedisCsvReport(redisContent);
    await sendCsvToAdmin(csvFilePath);
    log('Redis command executed successfully', 'debug');
    await notify(`Redis content report sent. Total reports: ${redisContent.length}`);
  } catch (error) {
    logErr('handleRedisCommand', error);
    await notify(`Error executing Redis command: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleLruCommand() {
  try {
    log('Handling /lru command', 'debug');
    const lruContent = getLruContent();
    const csvFilePath = await generateLruCsvReport(lruContent);
    await sendCsvToAdmin(csvFilePath);
    log('LRU command executed successfully', 'debug');
    await notify('LRU content report sent.');
  } catch (error) {
    logErr('handleLruCommand', error);
    await notify(`Error executing LRU command: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function getLruContent(): CachedDecision[] {
  return Array.from(lruCache.values());
}

async function generateLruCsvReport(lruContent: CachedDecision[]): Promise<string> {
  const csvFilePath = join(tmpdir(), 'lru_report.csv');
  const csvWriter = createObjectCsvWriter({
    path: csvFilePath,
    header: [
      {id: 'reportId', title: 'Report ID'},
      {id: 'isSpam', title: 'Is Spam'},
      {id: 'reason', title: 'Reason'},
      {id: 'checkType', title: 'Check Type'},
      {id: 'timestamp', title: 'Timestamp'},
    ]
  });

  await csvWriter.writeRecords(lruContent);
  log(`LRU CSV report generated: ${csvFilePath}`, 'debug');
  return csvFilePath;
}

async function waitForUndoResponse(reportId: string): Promise<'success' | 'toolate'> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      client.removeEventHandler(checkMessage, new NewMessage({}));
      resolve('toolate');
    }, 5000);

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
    }, 10000);

    const checkInterval = setInterval(async () => {
      const cachedReport = await getCachedReport(reportId);
      if (cachedReport && undoRange && isReportInUndoRange(reportId)) {
        clearTimeout(timeout);
        clearInterval(checkInterval);
        processingReports.delete(reportId);
        resolve(cachedReport);
      }
    }, 500);
  });
}

function startIdleUndoTimer() {
  if (idleUndoTimeout) {
    clearTimeout(idleUndoTimeout);
  }
  idleUndoTimeout = setTimeout(async () => {
    if (autoMode && messageBuffer.length === 0 && !isProcessingReports) {
      log('No reports processed for 45 seconds. Initiating automatic undo.', 'warn');
      await undoRecentReports();
    }
  }, IDLE_UNDO_DELAY);
}

function resetIdleUndoTimer() {
  lastReportProcessTime = Date.now();
  if (idleUndoTimeout) {
    clearTimeout(idleUndoTimeout);
  }
  if (autoMode) {
    startIdleUndoTimer();
  }
}

async function undoRecentReports() {
  if (isUndoInProgress) {
    log('Undo process is already in progress', 'warn');
    return;
  }

  isUndoInProgress = true;
  const MAX_UNDO_ATTEMPTS = 100;
  let undoCount = 0;
  const recentReportIds = await getRecentReportIds(MAX_UNDO_ATTEMPTS);

  try {
    for (const reportId of recentReportIds) {
      if (isProcessingReports) {
        log('Report processing resumed, cancelling undo process', 'info');
        return;
      }

      log(`Attempting to undo report ${reportId}`, 'debug');
      await sendToBot(`/undo${reportId}`);
      const undoResponse = await waitForUndoResponse(reportId);

      if (undoResponse === 'success') {
        log(`Successfully undone report ${reportId}`, 'debug');
        const report = await getReportFromCaches(reportId);
        if (report) {
          await processReport(report);
          log('Report processing resumed, cancelling further undos', 'info');
          return;
        } else {
          log(`Failed to retrieve report ${reportId} from caches`, 'warn');
        }
      } else if (undoResponse === 'toolate') {
        log(`Undo action no longer possible for report ${reportId}`, 'warn');
      }

      undoCount++;
      if (undoCount >= MAX_UNDO_ATTEMPTS) {
        log(`Reached maximum undo attempts (${MAX_UNDO_ATTEMPTS}). Stopping bot for 30 minutes.`, 'warn');
        await stopBotTemporarily();
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    logErr('Error in undoRecentReports', error);
  } finally {
    isUndoInProgress = false;
  }
}

function isReportInUndoRange(reportId: string): boolean {
  if (!undoRange) return false;
  const id = BigInt(reportId);
  return id >= BigInt(undoRange.start) && id <= BigInt(undoRange.end);
}

async function getCachedReport(reportId: string): Promise<Report | null> {
  try {
    const reportData = await redis.get(`report:${reportId}`);
    if (reportData) {
      const report = JSON.parse(reportData) as Report;
      report.isSpam = -1;
      report.reason = undefined;
      return report;
    }
  } catch (error) {
    logErr('getCachedReport', error);
  }
  return null;
}

function cleanupLRUCache(): void {
  const maxSize = MAX_CACHE_SIZE_MB * 1024 * 1024;
  let currentSize = 0;

  for (const [key, value] of lruCache.entries()) {
    currentSize += JSON.stringify(value).length + key.length;
    if (currentSize > maxSize) {
      lruCache.delete(key);
      log(`Removed old entry from LRU cache: ${key}`, 'debug');
    }
  }
}

async function cleanupCache() {
  if (isShuttingDown) {
    log('cleanupCache: Application is shutting down, cache cleanup skipped', 'debug');
    return;
  }

  try {
    const now = Date.now();
    let deletedCount = 0;

    for (const [key, value] of lruCache.entries()) {
      if (now - value.timestamp > 24 * 60 * 60 * 1000) {
        lruCache.delete(key);
        deletedCount++;
      }
    }

    if (redis.status === 'ready') {
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
    } else {
      log('Redis connection is not ready, skipping Redis cache cleanup', 'warn');
    }

    log(`Cleaned up ${deletedCount} old reports from cache`, 'info');
  } catch (error) {
    if (isShuttingDown) {
      log('cleanupCache: Application is shutting down, error ignored', 'debug');
    } else {
      logErr('cleanupCache', error);
    }
  }
}

async function getCacheSize(): Promise<number> {
  try {
    let totalSize = 0;

    for (const [key, value] of lruCache.entries()) {
      totalSize += JSON.stringify(value).length + key.length;
    }

    if (redis.status === 'ready') {
      const redisKeys = await redis.keys('report:*');
      const sampleSize = Math.min(100, redisKeys.length);
      let sampleTotalSize = 0;

      for (let i = 0; i < sampleSize; i++) {
        const randomIndex = Math.floor(Math.random() * redisKeys.length);
        const key = redisKeys[randomIndex];
        try {
          const value = await redis.get(key);
          if (value) {
            sampleTotalSize += key.length + value.length;
          }
        } catch (error) {
          log(`Error getting value for key ${key}: ${error instanceof Error ? error.message : String(error)}`, 'warn');
        }
      }

      const estimatedRedisSize = (sampleTotalSize / sampleSize) * redisKeys.length;
      totalSize += estimatedRedisSize;
    } else {
      log('Redis connection is not ready, skipping Redis cache size calculation', 'warn');
    }

    return totalSize / (1024 * 1024); // Return size in MB
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
      const excessSize = currentSize - MAX_CACHE_SIZE_MB;
      const removalRatio = excessSize / currentSize;

      const lruKeysToRemove = Math.ceil(lruCache.size * removalRatio);
      const lruKeys = Array.from(lruCache.keys()).slice(0, lruKeysToRemove);
      lruKeys.forEach(key => lruCache.delete(key));
      
      if (redis.status === 'ready') {
        const redisKeys = await redis.keys('report:*');
        const redisKeysToRemove = Math.ceil(redisKeys.length * removalRatio);
        const oldestKeys = redisKeys.sort().slice(0, redisKeysToRemove);
        
        if (oldestKeys.length > 0) {
          await redis.del(...oldestKeys);
          log(`Removed ${oldestKeys.length} oldest keys from Redis cache`, 'info');
        }
      } else {
        log('Redis connection is not ready, skipping Redis cache cleanup', 'warn');
      }

      log(`Removed approximately ${excessSize.toFixed(2)} MB from cache`, 'info');
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
      if (attribute instanceof Api.DocumentAttributeAnimated || document.mimeType === 'image/gif') {
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

async function undo(reportId?: string): Promise<boolean> {
  log(`Starting undo process${reportId ? ` for report ${reportId}` : ''}`, 'debug');
  
  const recentReportIds = reportId ? [reportId] : await getRecentReportIds(10);
  let successfulUndo = false;
  
  for (const id of recentReportIds) {
    const report = await getCachedReport(id);
    if (!report) {
      log(`Report ${id} not found in cache, skipping`, 'debug');
      continue;
    }

    if (!report.decisionSent) {
      log(`Decision not sent for report ${id}, skipping undo`, 'debug');
      continue;
    }

    const undoCommand = `/undo${id}`;
    log(`Sending undo command for report ${id}`, 'debug');
    await sendToBot(undoCommand);

    const undoResponse = await waitForUndoResponse(id);
    
    if (undoResponse === 'success') {
      log(`Successful undo for report ${id}`, 'debug');
      report.decisionSent = false;
      report.isOpen = true;
      await saveReportToRedis(report);
      
      try {
        await processReport(report);
        successfulUndo = true;
        log(`Successfully processed undone report ${id}`, 'debug');
        
        if (reportId) {
          return true;
        }
      } catch (error) {
        logErr(`Error processing undone report ${id}`, error);
      }
    } else if (undoResponse === 'toolate') {
      log(`Undo action no longer possible for report ${id}`, 'warn');
    } else {
      log(`Unexpected response for undo of report ${id}`, 'warn');
    }
  }

  log(`Undo process completed. Successfully undone and processed: ${successfulUndo}`, 'debug');
  return successfulUndo;
}

async function getRecentReportIds(limit: number): Promise<string[]> {
  const lruReports = Array.from(lruCache.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
    .map(decision => decision.reportId);

  if (lruReports.length < limit) {
    const redisKeys = await redis.keys('report:*');
    const redisReports = await Promise.all(
      redisKeys.map(async key => {
        const report = JSON.parse(await redis.get(key) || '{}') as Report;
        return { id: report.reportId, timestamp: report.timestamp };
      })
    );
    
    const additionalReports = redisReports
      .sort((a, b) => b.timestamp - a.timestamp)
      .filter(report => !lruReports.includes(report.id))
      .map(report => report.id)
      .slice(0, limit - lruReports.length);

    const combinedReports = [...lruReports, ...additionalReports];

    for (const reportId of combinedReports) {
      await addToRecentReportIds(reportId);
    }

    return combinedReports;
  }

  for (const reportId of lruReports) {
    await addToRecentReportIds(reportId);
  }

  return lruReports;
}

async function getRedisContent(): Promise<Report[]> {
  const reports: Report[] = [];
  const keys = await redis.keys('report:*');

  for (const key of keys) {
    const reportData = await redis.get(key);
    if (reportData) {
      try {
        const report = JSON.parse(reportData) as Report;
        reports.push(report);
      } catch (error) {
        log(`Error parsing report data for key ${key}: ${error}`, 'error');
      }
    }
  }

  return reports;
}

async function generateRedisCsvReport(redisContent: Report[]): Promise<string> {
  const csvFilePath = join(tmpdir(), 'redis_report.csv');
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
      {id: 'mediaHashes', title: 'Media Hashes'}
    ]
  });

  const reportData = redisContent.map(report => ({
    ...report,
    messageContent: report.messageContent.join('\n'),
    mediaHashes: report.mediaHashes.join(', ')
  }));

  await csvWriter.writeRecords(reportData);
  log(`Redis CSV report generated: ${csvFilePath}`, 'debug');
  return csvFilePath;
}

async function getReportFromCaches(reportId: string): Promise<Report | null> {
  const lruDecision = Array.from(lruCache.values()).find(decision => decision.reportId === reportId);
  if (lruDecision) {
    return {
      reportId: lruDecision.reportId,
      isSpam: lruDecision.isSpam,
      reason: lruDecision.reason,
      timestamp: lruDecision.timestamp,
      messageContent: [],
      mediaHashes: [],
      complaintCount: 0,
      source: '',
      sender: ''
    };
  }

  const redisKey = `report:${reportId}`;
  const redisReport = await redis.get(redisKey);
  if (redisReport) {
    return JSON.parse(redisReport) as Report;
  }

  return null;
}

async function addToRecentReportIds(reportId: string): Promise<void> {
  await redis.lpush('recent_report_ids', reportId);
  await redis.ltrim('recent_report_ids', 0, 9);
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
          startIdleUndoTimer();
          await notify('Automatic mode started. Decisions and bot commands will be sent.');
          await sendToBot("/next 2");
          break;

        case '/stop':
          autoMode = false;
          if (idleUndoTimeout) {
            clearTimeout(idleUndoTimeout);
            idleUndoTimeout = null;
          }
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
              COMMAND_DELAY = newDelay;
              await notify(`Command delay updated to ${COMMAND_DELAY} ms`);
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

        case '/redis':
          await handleRedisCommand();
          break;
      
        case '/lru':
          await handleLruCommand();
          break;

        case '/fine':
          try {
            const filePaths = await handleFineCommand();
            for (const filePath of filePaths) {
              await client.sendFile(ADMIN_ID, {
                file: filePath,
                caption: 'Fine-tuning data file',
                attributes: [
                  new Api.DocumentAttributeFilename({ fileName: path.basename(filePath) })
                ]
              });
            }
            await notify('Fine-tuning data files have been generated and sent.');
          } catch (error) {
            logErr('Error generating fine-tuning data', error);
            await notify('Error generating fine-tuning data. Please check the logs.');
          }
          break;

        case '/fix':
          if (commandParts.length === 2) {
            await handleFixCommand(commandParts[1]);
          } else {
            await notify('Invalid fix command. Usage: /fix [reportId]');
          }
          break;

        default:
          log(`Unrecognized admin command: ${command}`, 'debug');
          await notify(`Unrecognized command: ${command}. Available commands are:
          /start - Start automatic mode
          /stop - Stop automatic mode
          /status - Get current status
          /undos [startReportId] [endReportId] - Undo and recheck reports in range
          /delay [value] - Set command delay in milliseconds
          /reset - Clear Redis and LRU caches
          /db - Perform database operations and generate report
          /redis - Get cache info and generate report
          /lru - Get cache info and generate report
          /fine - Generate fine-tuning data
          /fix [reportId] - Fix and reassess a specific report`);
      }
    } catch (error) {
      logErr(`Error processing admin command: ${command}`, error);
      await notify(`Error processing command ${command}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function handleFixCommand(reportId: string): Promise<void> {
  log(`Handling fix command for report ${reportId}`, 'debug');
  try {
    const report = await getReportFromCaches(reportId);
    if (!report) {
      await notify(`Report ${reportId} not found in caches.`);
      return;
    }

    report.isSpam = report.isSpam === 1 ? 0 : 1;
    report.reason = `Manual fix: ${report.isSpam === 1 ? 'marked as spam' : 'marked as not spam'}`;
    report.checkType = 'manual';

    await saveReportToRedis(report);
    await saveCache(report, {
      isSpam: report.isSpam,
      reason: report.reason,
      checkType: 'manual'
    });

    // Удаляем прямое обновление PostgreSQL
    // Данные будут обновлены при следующем выполнении saveRedisToPostgres

    await notify(`Report ${reportId} has been fixed. New status: ${report.isSpam === 1 ? 'spam' : 'not spam'}`);
  } catch (error) {
    logErr(`Error fixing report ${reportId}`, error);
    await notify(`Error fixing report ${reportId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function stopBotTemporarily() {
  autoMode = false;
  await notify('Bot stopped due to reaching maximum undo attempts. Will restart in 30 minutes.');

  const restartTime = new Date(Date.now() + 30 * 60 * 1000);
  schedule.scheduleJob(restartTime, async () => {
    log('Restarting application after 30 minutes pause', 'info');
    await gracefulShutdown(true);
  });
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

    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;

    statusMessage += `CPU Usage: ${os.loadavg()[0].toFixed(2)}%
Memory Usage: ${((usedMemory / totalMemory) * 100).toFixed(2)}%
Free Memory: ${(freeMemory / 1024 / 1024 / 1024).toFixed(2)} GB
Total Memory: ${(totalMemory / 1024 / 1024 / 1024).toFixed(2)} GB

`;

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
    log('Attempting to clear Redis and LRU caches...', 'debug');
    
    await redis.flushdb();
    
    lruCache.clear();
    
    log('Redis and LRU caches cleared successfully', 'debug');
    await notify('Redis and LRU caches have been cleared successfully');
  } catch (error) {
    logErr('resetRedisCache', error);
    await notify(`Error in resetRedisCache: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleDbCommand() {
  try {
    log('Handling /db command', 'debug');
    await saveRedisToPostgres();
    const cacheContent = await getCacheContent();
    const csvFilePath = await generateCacheCsvReport(cacheContent);
    await sendCsvToAdmin(csvFilePath);
    log('DB command executed successfully', 'debug');
    await notify('Database operations completed. CSV report sent.');
  } catch (error) {
    logErr('handleDbCommand', error);
    await notify(`Error executing DB command: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function getCacheContent(): Promise<Report[]> {
  const reports: Report[] = [];

  for (const [key, value] of lruCache) {
    reports.push({
      reportId: key,
      messageContent: [],
      mediaHashes: [],
      complaintCount: 0,
      source: '',
      sender: '',
      isSpam: value.isSpam,
      reason: value.reason,
      timestamp: Date.now(),
      checkType: value.checkType
    });
  }

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
      {id: 'messageContent', title: 'Message Content'}
    ]
  });

  const reportData = reports.map(report => ({
    ...report,
    messageContent: report.messageContent.join('\n'),
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

    const now = new Date();
    for (let i = 0; i < 24; i++) {  // Create partitions for 2 years ahead
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
        log(`Created partition ${partitionName}`, 'info');
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
          // Only include reports with non-empty message content
          if (report.messageContent.length > 0 && report.messageContent.some(msg => msg.trim() !== '')) {
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
          }
          return null;
        }).filter(value => value !== null);

        if (values.length > 0) {
          const query = `
            INSERT INTO reports 
            (report_id, message_content, media_hashes, complaint_count, source, sender, is_spam, reason, created_at)
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

          try {
            await client.query(query, values.flat());
          } catch (error) {
            if (error instanceof Error && error.message.includes('no partition of relation "reports" found for row')) {
              log(`No partition found for some reports. Creating new partition.`, 'warn');
              await initDB();  // This will create new partitions if needed
              // Retry the insert
              await client.query(query, values.flat());
            } else {
              throw error;
            }
          }
        }
      }

      await client.query('COMMIT');
      log(`Successfully transferred reports from Redis to PostgreSQL`, 'info');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof Error) {
      logErr('saveRedisToPostgres', `${error.message}\n${error.stack}`);
    } else {
      logErr('saveRedisToPostgres', String(error));
    }
    await notify(`Error in saveRedisToPostgres: ${error instanceof Error ? error.message : String(error)}`);
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

    const currentTime = Date.now();
    const timeSinceLastReport = currentTime - lastReportProcessTime;

    if (timeSinceLastReport > 5 * 60 * 1000 && timeSinceLastReport <= 10 * 60 * 1000) {
      log('No reports processed in the last 5 minutes. Sending "/next 7" command.', 'warn');
      await sendToBot("/next 7");
    } else if (timeSinceLastReport > 10 * 60 * 1000) {
      throw new Error('No reports processed in the last 10 minutes');
    }

    log('System health check passed', 'info');
  } catch (error) {
    logErr('System health check failed', error);
    await notify(`System health check failed: ${error instanceof Error ? error.message : String(error)}. Attempting restart...`);
    process.exit(1);
  }
}

// Cleanup function for old data
async function cleanupOldData() {
  const startTime = Date.now();
  log('Starting cleanup of old data', 'info');

  try {
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    // LRU Cache cleanup
    let lruDeletedCount = 0;
    for (const [key, value] of lruCache.entries()) {
      if (value.timestamp < oneMonthAgo.getTime()) {
        lruCache.delete(key);
        lruDeletedCount++;
      }
    }
    log(`LRU Cache cleanup completed. Deleted ${lruDeletedCount} items.`, 'info');

    // Redis cleanup with prioritization of unique content
    if (redis.status === 'ready') {
      const keys = await redis.keys('report:*');
      const batchSize = 1000;
      let redisDeletedCount = 0;
      let contentMap = new Map<string, string[]>();

      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        const pipeline = redis.pipeline();

        for (const key of batch) {
          const reportData = await redis.get(key);
          if (reportData) {
            const report = JSON.parse(reportData) as Report;
            const content = report.messageContent.join('\n');
            if (!contentMap.has(content)) {
              contentMap.set(content, []);
            }
            contentMap.get(content)!.push(key);
          }
        }

        // Delete duplicates and old data
        for (const [content, reportKeys] of contentMap.entries()) {
          if (reportKeys.length > 1) {
            // Keep the most recent report for duplicate content
            reportKeys.sort((a, b) => parseInt(b.split(':')[1]) - parseInt(a.split(':')[1]));
            const keepKey = reportKeys.shift()!;
            for (const key of reportKeys) {
              pipeline.del(key);
              redisDeletedCount++;
            }
            
            // Increase importance of the kept report
            pipeline.expire(keepKey, 60 * 60 * 24 * 60); // Extend TTL to 60 days
          } else {
            const key = reportKeys[0];
            const report = JSON.parse(await redis.get(key) || '{}') as Report;
            if (new Date(report.timestamp) < oneMonthAgo) {
              pipeline.del(key);
              redisDeletedCount++;
            }
          }
        }

        await pipeline.exec();
        log(`Redis cleanup progress: ${i + batch.length}/${keys.length}`, 'debug');

        if (Date.now() - startTime > 10 * 60 * 1000) {
          log('Cleanup taking too long, will continue in next run', 'warn');
          break;
        }
      }
      log(`Redis cleanup completed. Deleted ${redisDeletedCount} items.`, 'info');
    } else {
      log('Redis is not ready, skipping Redis cleanup', 'warn');
    }

    // PostgreSQL partition cleanup
    const client = await pool.connect();
    try {
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

        if (Date.now() - startTime > 10 * 60 * 1000) {
          log('Partition cleanup taking too long, will continue in next run', 'warn');
          break;
        }
      }
    } finally {
      client.release();
    }

    const duration = (Date.now() - startTime) / 1000;
    log(`Cleanup of old data completed in ${duration.toFixed(2)} seconds`, 'info');
  } catch (error) {
    logErr('Error during cleanup of old data', error);
  }
}

// Graceful shutdown
async function gracefulShutdown(restart: boolean = false) {
  log(`Starting graceful shutdown... ${restart ? '(Restarting)' : ''}`, 'info');

  autoMode = false;
  await notify(`Automatic mode stopped due to application ${restart ? 'restart' : 'shutdown'}.`);

  clearExistingTimers();

  isShuttingDown = true;

  processingReports.clear();

  const safeRedisOperation = async (operation: () => Promise<void>) => {
    if (redis.status === 'ready') {
      try {
        await operation();
      } catch (error) {
        logErr('Redis operation during shutdown', error);
      }
    }
  };

  await safeRedisOperation(async () => {
    if (redisBatch.length > 0) {
      await saveRedisBatch();
    }
  });

  try {
    await pool.end();
    log('Database connection closed', 'info');
  } catch (error) {
    logErr('gracefulShutdown - closing database connection', error);
  }

  try {
    if (client && client.connected) {
      await client.disconnect();
      log('Telegram client disconnected', 'info');
    }
  } catch (error) {
    logErr('gracefulShutdown - disconnecting Telegram client', error);
  }

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
    const { spawn } = await import('child_process');
    spawn(process.argv[0], process.argv.slice(1), {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    }).unref();
  }

  process.exit(restart ? 1 : 0);
}

function clearExistingTimers() {
  if (redisBatchTimeout) clearTimeout(redisBatchTimeout);
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
    schedule.scheduleJob('0 5 * * *', cleanupOldData);
    schedule.scheduleJob('*/30 * * * *', cleanupCache);
    schedule.scheduleJob('*/5 * * * *', cleanupLRUCache);
    schedule.scheduleJob('*/5 * * * *', checkStuckReports);
    schedule.scheduleJob('0 0 1 * *', initDB);  // Выполнять initDB в полночь первого дня каждого месяца

    log('Periodic tasks scheduled', 'info');

    log('Application initialized successfully', 'info');
    await notify('Application initialized successfully');
    
    log('Sending initial status report', 'debug');
    await sendStatus();
    log('Initial status report sent', 'debug');

    if (autoMode) {
      log('Starting auto mode', 'info');
      startIdleUndoTimer();
      try {
        await sendToBot("/next 1");
        log('Initial "/next 1" command sent successfully', 'debug');
      } catch (error) {
        logErr('Failed to send initial "/next 1" command', error);
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

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', async (error) => {
  logErr('Uncaught Exception', error);
  await notify('Uncaught Exception occurred. Application will restart.');
  await gracefulShutdown(true);
});

process.on('unhandledRejection', async (reason, promise) => {
  logErr('Unhandled Rejection', reason);
  await notify('Unhandled Rejection occurred. Application will restart.');
  await gracefulShutdown(true);
});

// Handle SIGTERM signal for graceful shutdown
process.on('SIGTERM', async () => {
  log('SIGTERM signal received', 'info');
  await notify('SIGTERM signal received. Application will shut down gracefully.');
  await gracefulShutdown();
});

// Handle SIGINT signal for graceful shutdown (e.g., when pressing Ctrl+C)
process.on('SIGINT', async () => {
  log('SIGINT signal received', 'info');
  await notify('SIGINT signal received. Application will shut down gracefully.');
  await gracefulShutdown();
});

// Express routes
app.get('/health', async (req, res) => {
  try {
    await checkSystemHealth();
    res.status(200).json({ status: 'healthy' });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/status', async (req, res) => {
  try {
    const cacheSize = await getCacheSize();
    const dbStatus = await checkDB();
    const redisStatus = redis.status === 'ready';
    const telegramStatus = client && client.connected;

    const status = {
      autoMode,
      cacheSize: `${cacheSize.toFixed(2)} MB`,
      dbStatus,
      redisStatus,
      telegramStatus,
      apiRequestsCount,
      apiTokensUsed,
      lastReportProcessTime: new Date(lastReportProcessTime).toISOString(),
      processingReportsCount: processingReports.size,
    };

    res.status(200).json(status);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Helper function to get media content
async function getMediaContent(mediaKey: string): Promise<Buffer | null> {
  try {
    const mediaBase64 = await redis.get(mediaKey);
    if (mediaBase64) {
      return Buffer.from(mediaBase64, 'base64');
    }
  } catch (error) {
    logErr('getMediaContent', error);
  }
  return null;
}

// Helper function to determine media type
function getMediaType(mediaHash: string): string {
  const mediaType = mediaHash.split(':')[0];
  switch (mediaType) {
    case 'photo':
      return 'image/jpeg';
    case 'video':
      return 'video/mp4';
    case 'videonote':
      return 'video/mp4';
    case 'gif':
      return 'image/gif';
    case 'sticker':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

// Route to serve media content
app.get('/media/:reportId/:mediaIndex', async (req, res) => {
  const { reportId, mediaIndex } = req.params;
  try {
    const report = await getCachedReport(reportId);
    if (!report) {
      return res.status(404).send('Report not found');
    }

    const mediaHash = report.mediaHashes[parseInt(mediaIndex)];
    if (!mediaHash) {
      return res.status(404).send('Media not found');
    }

    const mediaKey = `media:${mediaHash.split(':')[1]}`;
    const mediaContent = await getMediaContent(mediaKey);
    if (!mediaContent) {
      return res.status(404).send('Media content not found');
    }

    const mediaType = getMediaType(mediaHash);
    res.contentType(mediaType);
    res.send(mediaContent);
  } catch (error) {
    logErr(`Error serving media for report ${reportId}`, error);
    res.status(500).send('Internal server error');
  }
});

// Route to get report details
app.get('/report/:reportId', async (req, res) => {
  const { reportId } = req.params;
  try {
    const report = await getCachedReport(reportId);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Remove sensitive information
    const safeReport = {
      ...report,
      mediaHashes: report.mediaHashes.map((_, index) => `/media/${reportId}/${index}`),
    };

    res.json(safeReport);
  } catch (error) {
    logErr(`Error fetching report ${reportId}`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Route to manually trigger undo for a specific report
app.post('/undo/:reportId', async (req, res) => {
  const { reportId } = req.params;
  try {
    const success = await undo(reportId);
    if (success) {
      res.json({ message: `Successfully undone report ${reportId}` });
    } else {
      res.status(400).json({ error: `Failed to undo report ${reportId}` });
    }
  } catch (error) {
    logErr(`Error undoing report ${reportId}`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logErr('Express error', err);
  res.status(500).json({ error: 'Internal server error' });
});

export { app, client, redis, pool, openai, lruCache };