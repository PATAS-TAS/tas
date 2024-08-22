import { NewMessage, NewMessageEvent } from 'telegram/events/NewMessage.js';
import { StringSession } from 'telegram/sessions/index.js';
import { TelegramClient } from 'telegram/index.js';
import { Api } from 'telegram/tl/index.js';
import bigInt from "big-integer";
import express from 'express';
import dotenv from 'dotenv';
import pkg from 'pg';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createObjectCsvWriter } from 'csv-writer';
import winston from 'winston';
import Redis from 'ioredis';
import schedule from 'node-schedule';

// Загрузка переменных окружения и инициализация
dotenv.config();

const DEEP_LOG = process.env.DEEP_LOG === 'true';
const PORT = process.env.PORT || 3000;
const ADMIN_ID = parseInt(process.env.ADMIN_ID!, 10);
const DB_URL = process.env.DATABASE_URL!;
const REDIS_URL = process.env.REDIS_URL!;
const API_ID = parseInt(process.env.API_ID!, 10);
const API_HASH = process.env.API_HASH!;
const SESSION_STRING = process.env.SESSION_STRING!;
const BOT_ID = process.env.BOT_ID!;
const BOT_ACCESS_HASH = process.env.BOT_ACCESS_HASH!;
const DB_CHECK_INTERVAL = parseInt(process.env.DB_CHECK_INTERVAL || '60000', 10);
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '300000', 10);

const app = express();
const { Pool } = pkg;
const redis = new Redis.Redis(REDIS_URL);

// Настройка логгера
const logger = winston.createLogger({
  level: DEEP_LOG ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

const log = (msg: string) => logger.info(msg);
const logErr = (ctx: string, err: unknown) => {
  const errMsg = err instanceof Error ? err.message : String(err);
  logger.error(`Error in ${ctx}: ${errMsg}`);
  notify(`Error in ${ctx}: ${errMsg}`).catch(e => 
    logger.error(`Failed to notify admin: ${e instanceof Error ? e.message : String(e)}`)
  );
};

// Интерфейсы и типы
interface Report {
  reportId: string;
  messageContent?: string[];
  mediaHashes?: string[];
  complaintCount: number;
  source: string;
  sender: string;
  spamProbability: number;
  hasExternalLink: boolean;
  hasInternalLink: boolean;
  modFlood: number;
  modNotSpam: number;
  isSpam: boolean;
  reason?: string;
}

interface ValidationResult {
  isValid: boolean;
  error?: string;
}

interface SpamDecision {
  isSpam: boolean;
  reason?: string;
}

enum ReportProcessingState {
  IDLE,
  WAITING_FOR_MODERATOR_OPINION,
  WAITING_FOR_NEXT_REPORT
}

// Глобальные переменные
let client: TelegramClient;
let botEntity: Api.InputPeerUser | null = null;
let currentReport: Partial<Report> = {};
let autoMode = false;
let isProcessing = false;
let notifyAttempts = 0;
let currentState: ReportProcessingState = ReportProcessingState.IDLE;

const MAX_NOTIFY_ATTEMPTS = 3;
const reportQueue: Report[] = [];
const dangEx = ['.exe', '.apk', '.bat', '.cmd', '.msi', '.vbs', '.js', '.scr', '.pif'];

const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

const sysRegex = {
  reportId: /#r(\d+)/,
  complaintCount: /😱(\d+)/,
  source: /^(?:🗣\s*)?Source:\s*(.+)/m,
  sender: /^Sender:\s*(.+)/m,
  spamProbability: /(?:🌕|🌔|🌓|🌒|🌚)\s*(\d+)%/,
  modFlood: /– Flood/,
  modNotSpam: /– Not Spam/,
  externalLink: /🔴/,
  internalLink: /🔶/
};

// -------------------- Инициализация и настройка --------------------

async function initClient(): Promise<TelegramClient> {
  if (!API_ID || !API_HASH || !SESSION_STRING) {
    throw new Error('API_ID, API_HASH, and SESSION_STRING must be set in .env file');
  }

  DEEP_LOG && log('Initializing Telegram client...');
  const stringSession = new StringSession(SESSION_STRING);
  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
    retryDelay: 1000,
    useWSS: true,
    requestRetries: 5,
  });

  try {
    await client.connect();
    const isAuthorized = await client.checkAuthorization();
    if (!isAuthorized) {
      throw new Error('Client is not authorized. Please check your session string.');
    }
    DEEP_LOG && log('Client connected and authorized successfully');
    return client;
  } catch (error) {
    logErr('initClient', error);
    throw error;
  }
}

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    DEEP_LOG && log('Creating reports table if not exists...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        report_id TEXT UNIQUE,
        message_content TEXT[],
        media_hashes TEXT[],
        complaint_count INTEGER NOT NULL,
        source TEXT NOT NULL,
        sender TEXT NOT NULL,
        spam_probability INTEGER,
        has_external_link BOOLEAN,
        has_internal_link BOOLEAN,
        mod_flood INTEGER DEFAULT 0,
        mod_not_spam INTEGER DEFAULT 0,
        is_spam BOOLEAN,
        reason TEXT,
        decision TEXT,
        created_at TEXT DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'DD.MM.YY, HH24:MI:SS')
      );
    `);
    
    DEEP_LOG && log('Altering spam_probability column...');
    await client.query(`
      ALTER TABLE reports
      ALTER COLUMN spam_probability DROP NOT NULL;
    `);
    
    await client.query('COMMIT');
    DEEP_LOG && log('Database initialized successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    logErr('initDB', error);
    throw error;
  } finally {
    client.release();
  }
}

async function initBot() {
  if (!BOT_ID || !BOT_ACCESS_HASH) {
    throw new Error('BOT_ID and BOT_ACCESS_HASH must be set in .env file');
  }

  try {
    DEEP_LOG && log(`BOT_ID: ${BOT_ID}, BOT_ACCESS_HASH: ${BOT_ACCESS_HASH}`);
    botEntity = new Api.InputPeerUser({
      userId: bigInt(BOT_ID),
      accessHash: bigInt(BOT_ACCESS_HASH)
    });
    DEEP_LOG && log('Bot entity initialized successfully');
  } catch (error) {
    logErr('initBot', error);
    throw error;
  }
}

async function setupHandlers() {
  if (!botEntity) throw new Error('Bot entity not initialized');
  const botUserId = botEntity.userId.toJSNumber();

  const handlers = [
    { handler: handleCheck, options: { fromUsers: [botUserId], incoming: true, forwards: true } },
    { handler: handleSys, options: { fromUsers: [botUserId], incoming: true, pattern: /😱\d+/ } },
    { handler: handleAddMsg, options: { fromUsers: [botUserId], incoming: true } },
    { handler: handleAdmin, options: { fromUsers: [ADMIN_ID], incoming: true } }
  ];

  handlers.forEach(({ handler, options }) => {
    try {
      client.addEventHandler(handler, new NewMessage(options));
      DEEP_LOG && log(`Handler ${handler.name} set up successfully`);
    } catch (error) {
      logErr(`setupHandlers - ${handler.name}`, error);
    }
  });

  DEEP_LOG && log('All event handlers set up successfully');
}

// -------------------- Обработка сообщений --------------------

async function handleCheck(event: NewMessageEvent) {
  if (!autoMode) {
    DEEP_LOG && log('Automatic mode is off, skipping message check');
    return;
  }

  const message = event.message;
  if (
    message instanceof Api.Message &&
    event.isPrivate &&
    botEntity &&
    message.senderId?.toString() === botEntity.userId.toString()
  ) {
    DEEP_LOG && log(`Received message for check: ${message.message}`);
    
    if (currentState === ReportProcessingState.WAITING_FOR_NEXT_REPORT) {
      currentState = ReportProcessingState.IDLE;
      return;
    }
    
    if (!currentReport.messageContent) currentReport.messageContent = [];
    if (!currentReport.mediaHashes) currentReport.mediaHashes = [];
    
    let processedMessage = preprocessMessage(message.message || '');
    
    if (message.media instanceof Api.MessageMediaStory) {
      const caption = (message.media as any).caption;
      if (caption) processedMessage += ` [Story Caption: ${caption}]`;
    }
    
    if (message.replyTo) {
      try {
        const repliedMessage = await message.getReplyMessage();
        if (repliedMessage?.message) {
          processedMessage += ` [Quoted: ${repliedMessage.message}]`;
        }
      } catch (error) {
        logErr('handleCheck - getting replied message', error);
      }
    }
    
    if (processedMessage) currentReport.messageContent.push(processedMessage);
    
    if (message.media) {
      try {
        const mediaHash = await getMediaHash(message.media);
        currentReport.mediaHashes.push(mediaHash);
      } catch (error) {
        logErr('handleCheck - getting media hash', error);
      }
    }
    
    DEEP_LOG && log(`Current report: ${JSON.stringify(currentReport, null, 2)}`);
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
    DEEP_LOG && log(`Received system message: ${message.message}`);

    const sysInfo = parseSysMsg(message.message || '');
    DEEP_LOG && log(`Parsed system info: ${JSON.stringify(sysInfo, null, 2)}`);

    if (currentState === ReportProcessingState.WAITING_FOR_MODERATOR_OPINION) {
      currentReport = { ...currentReport, ...sysInfo };
      DEEP_LOG && log(`Current report updated with moderator opinions: ${JSON.stringify(currentReport, null, 2)}`);
      const index = reportQueue.findIndex(report => report.reportId === currentReport.reportId);
      if (index !== -1) {
        reportQueue[index] = currentReport as Report;
      }
      currentState = ReportProcessingState.IDLE;
      return;
    }

    currentReport = { ...sysInfo };
    DEEP_LOG && log(`New report received: ${JSON.stringify(currentReport, null, 2)}`);

    if (!currentReport.reportId) {
      log('Warning: reportId is missing in the current report');
    } else {
      DEEP_LOG && log(`Report ID found: ${currentReport.reportId}`);
    }

    const validationResult = validateReport(currentReport as Report);
    if (validationResult.isValid) {
      if (autoMode) {
        reportQueue.push(currentReport as Report);
        DEEP_LOG && log('Current report added to queue');
        processNextReport();
      } else {
        await saveToCache(currentReport as Report);
        DEEP_LOG && log('Current report saved to cache (auto mode off)');
      }
    } else {
      log(`Report validation failed: ${validationResult.error}`);
      DEEP_LOG && log(`Invalid report data: ${JSON.stringify(currentReport, null, 2)}`);
    }
  }
}

async function handleAddMsg(event: NewMessageEvent) {
  const message = event.message;
  if (
    message instanceof Api.Message &&
    event.isPrivate &&
    botEntity &&
    message.senderId?.toString() === botEntity.userId.toString()
  ) {
    DEEP_LOG && log(`Received additional message: ${message.message}`);

    switch (message.message) {
      case "No Reports Found":
        DEEP_LOG && log('No reports found, sending /undo');
        await sendToBot("/undo");
        break;
      case "Hello there! Send /next to start processing reports.":
        if (autoMode) {
          await sendToBot("/next");
        }
        break;
      case "Please select 😡 BAN or 😌 NO.":
      case "Sorry, an error has occurred during your request. Please try again later.":
        await sendToBot("/undo");
        break;
      default:
        if (message.message.startsWith("Your Fee for this month:")) {
          DEEP_LOG && log(`Earnings info received: ${message.message}`);
          await notify(`Earnings update: ${message.message}`);
        }
    }
  }
}

async function handleAdmin(event: NewMessageEvent) {
  if (!client || !client.connected) {
    DEEP_LOG && log('Telegram client not connected. Attempting to reconnect...');
    try {
      await reconnectClient();
    } catch (error) {
      logErr('handleAdmin - reconnectClient', error);
      return;
    }
  }

  const message = event.message;
  if (message instanceof Api.Message && message.senderId?.toString() === ADMIN_ID.toString()) {
    DEEP_LOG && log(`Received admin message: ${message.message}`);
    const command = message.message.toLowerCase();

    switch (command) {
      case '/start':
        await startAutoMode();
        await notify('Automatic mode started');
        break;
      case '/stop':
        stopAutoMode();
        await notify('Automatic mode stopped');
        break;
      case '/db':
        await handleDbExport();
        break;
      case '/status':
        await sendStatus();
        break;
      default:
        if (command.startsWith('/time ')) {
          const time = parseInt(command.split(' ')[1], 10);
          if (!isNaN(time) && time > 0) {
            process.env.PROCESSING_INTERVAL = time.toString();
            await notify(`Processing interval set to ${time} ms`);
          } else {
            await notify('Invalid time value. Please enter a positive number.');
          }
        } else {
          DEEP_LOG && log(`Unrecognized admin command: ${command}`);
        }
    }
  }
}

// -------------------- Основные функции обработки --------------------

async function processReport(report: Report): Promise<void> {
  const processingInterval = getProcessingInterval();
  const startTime = Date.now();

  // Параллельное выполнение проверки на очевидный спам и проверки кэша
  const [obviousSpamDecision, cachedReport] = await Promise.all([
    detectObviousSpam(report as unknown as Api.Message, report),
    checkCache(report)
  ]);

  // Обработка результата проверки на очевидный спам
  if (obviousSpamDecision.isSpam) {
    DEEP_LOG && log(`Obvious spam detected: ${obviousSpamDecision.reason}`);
    report.isSpam = true;
    report.reason = obviousSpamDecision.reason || 'Obvious spam detection';
    await sendDecision('😡 SPAM');
    await saveReport(report);
    await ensureMinimumInterval(startTime, processingInterval);
    return;
  }

  // Обработка результата проверки кэша
  if (cachedReport) {
    DEEP_LOG && log(`Using cached result for report ${report.reportId}: ${cachedReport.isSpam ? 'SPAM' : 'NOT SPAM'}`);
    await sendDecision(cachedReport.isSpam ? '😡 SPAM' : '😌 NO');
    await ensureMinimumInterval(startTime, processingInterval);
    return;
  }

  // Если не найдено в кэше и не является очевидным спамом:
  await sendToBot("/stats");

  currentState = ReportProcessingState.WAITING_FOR_MODERATOR_OPINION;
  await sendToBot(report.reportId);

  // Обработка мнений модераторов
  const decision = await processModeratorsOpinions(report);

  if (decision === "/undo") {
    DEEP_LOG && log("No conclusive moderator opinions, sending /undo");
    await sendToBot("/undo");
    currentState = ReportProcessingState.IDLE;
    await ensureMinimumInterval(startTime, processingInterval);
    return;
  }

  currentState = ReportProcessingState.WAITING_FOR_NEXT_REPORT;
  await sendToBot("/next");

  // Ожидаем следующий отчет
  const nextReportTimeout = 10000; // 10 секунд максимального ожидания
  const nextReportStartTime = Date.now();
  while (currentState === ReportProcessingState.WAITING_FOR_NEXT_REPORT) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (Date.now() - nextReportStartTime > nextReportTimeout) {
      DEEP_LOG && log("Timeout waiting for next report");
      break;
    }
  }

  report.isSpam = decision === '😡 SPAM';
  await sendDecision(decision);
  await saveReport(report);

  currentState = ReportProcessingState.IDLE;
  await ensureMinimumInterval(startTime, processingInterval);
}

async function processModeratorsOpinions(report: Report): Promise<string> {
  const moderatorOpinionTimeout = 30000; // 30 секунд максимального ожидания
  const startTime = Date.now();
  let lastOpinionTime = startTime;
  
  while (Date.now() - lastOpinionTime < moderatorOpinionTimeout) {
    await new Promise(resolve => setTimeout(resolve, 100)); // Короткие интервалы проверки
    
    if (report.modFlood > 0 || report.modNotSpam > 0) {
      // Получено новое мнение модератора, обновляем время последнего мнения
      lastOpinionTime = Date.now();
      DEEP_LOG && log(`Received moderator opinion. Current state: Flood ${report.modFlood}, NotSpam ${report.modNotSpam}`);
    }
    
    // Проверяем, можем ли мы принять решение на основе текущих мнений
    const decision = makeDecision(report);
    if (decision !== "/undo") {
      DEEP_LOG && log(`Decision made: ${decision}`);
      return decision;
    }
    
    // Проверяем, не превысили ли мы общее время ожидания
    if (Date.now() - startTime >= 60000) { // Максимум 60 секунд общего ожидания
      DEEP_LOG && log("Reached maximum total waiting time for moderator opinions");
      break;
    }
  }

  DEEP_LOG && log("No conclusive moderator opinions received within the timeout period");
  return "/undo";
}

function makeDecision(report: Report): string {
  if (report.modFlood >= 2) return "😡 SPAM";
  if (report.modNotSpam >= 2) return "😌 NO";
  if (report.modFlood === 1 && report.modNotSpam === 0) return "😡 SPAM";
  if (report.modNotSpam === 1 && report.modFlood === 0) return "😌 NO";
  if (report.modFlood === 1 && report.modNotSpam === 1) return "😌 NO";
  if (report.modFlood === 0 && report.modNotSpam === 0) return "/undo";
  
  DEEP_LOG && log(`Unexpected voting combination: modFlood = ${report.modFlood}, modNotSpam = ${report.modNotSpam}`);
  return "😌 NO";
}

async function detectObviousSpam(message: Api.Message, report: Partial<Report>): Promise<SpamDecision> {
  if ((message.media || 
     message.message && (message.message.includes('http') || message.message.includes('@') || message.message.match(/\+?[0-9]{10,14}/))) 
    && report.complaintCount && report.complaintCount > 2) {
    return { isSpam: true, reason: 'Media or links with high complaint count' };
  }

  if (message.media instanceof Api.MessageMediaStory) {
    return { isSpam: true, reason: 'Story content' };
  }

  if (message.replyMarkup instanceof Api.ReplyInlineMarkup) {
    for (const row of message.replyMarkup.rows) {
      for (const button of row.buttons) {
        if (button instanceof Api.KeyboardButtonUrl) {
          return { isSpam: true, reason: 'URL button detected' };
        }
      }
    }
  }

  if (report.messageContent && report.messageContent.length > 3 && 
    new Set(report.messageContent).size < report.messageContent.length * 0.7) {
    return { isSpam: true, reason: 'Duplicate messages detected' };
  }

  const linkRegex = /(https?:\/\/[^\s]+)|(@\w+)/g;
  const links = message.message?.match(linkRegex) || [];
  const linkCounts = new Map<string, number>();
  for (const link of links) {
    const count = linkCounts.get(link) || 0;
    if (count > 2) {
      return { isSpam: true, reason: 'Repeated links or usernames' };
    }
    linkCounts.set(link, count + 1);
  }

  if (message.media instanceof Api.MessageMediaDocument && 
    message.media.document instanceof Api.Document) {
    const fileName = message.media.document.attributes
      .find((attr): attr is Api.DocumentAttributeFilename => attr instanceof Api.DocumentAttributeFilename)?.fileName;
    if (fileName && dangEx.includes(path.extname(fileName).toLowerCase())) {
      return { isSpam: true, reason: 'Potentially harmful file detected' };
    }
  }

  return { isSpam: false };
}

// -------------------- Вспомогательные функции --------------------

function preprocessMessage(message: string): string {
  return message.split('\n').slice(1).join('\n');
}

function parseSysMsg(msg: string): Partial<Report> {
  const info: Partial<Report> = {
    modFlood: 0,
    modNotSpam: 0,
    hasExternalLink: false,
    hasInternalLink: false,
    spamProbability: 0
  };

  const reportIdMatch = msg.match(/#r(\d+)/);
  if (reportIdMatch) info.reportId = reportIdMatch[0];

  const complaintMatch = msg.match(/😱(\d+)/);
  if (complaintMatch) info.complaintCount = parseInt(complaintMatch[1]);

  info.hasExternalLink = /🔴/.test(msg);
  info.hasInternalLink = /🔶/.test(msg);

  const sourceMatch = msg.match(/^(?:🗣\s*)?Source:\s*(.+)/m);
  if (sourceMatch) info.source = sourceMatch[1].trim();

  const senderMatch = msg.match(/^Sender:\s*(.+)/m);
  if (senderMatch) info.sender = senderMatch[1].trim();

  const spamProbMatch = msg.match(/(?:🌕|🌔|🌓|🌒|🌚)\s*(\d+)%/);
  if (spamProbMatch) info.spamProbability = parseInt(spamProbMatch[1]);

  const lines = msg.split('\n');
  for (const line of lines) {
    if (/– Flood/.test(line)) {
      info.modFlood = (info.modFlood || 0) + 1;
    }
    if (/– Not Spam/.test(line)) {
      info.modNotSpam = (info.modNotSpam || 0) + 1;
    }
  }

  return info;
}

async function getMediaHash(media: Api.TypeMessageMedia): Promise<string> {
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

  return `unknown:${crypto.createHash('md5').update(JSON.stringify(media)).digest('hex')}`;
}

function validateReport(report: Partial<Report>): ValidationResult {
  if (!report.reportId || typeof report.reportId !== 'string') {
    return { isValid: false, error: `Invalid or missing reportId: ${JSON.stringify(report.reportId)}` };
  }
  if (report.complaintCount === undefined || typeof report.complaintCount !== 'number' || report.complaintCount < 0) {
    return { isValid: false, error: `Invalid or missing complaintCount: ${JSON.stringify(report.complaintCount)}` };
  }
  if (!report.source || typeof report.source !== 'string') {
    return { isValid: false, error: `Invalid or missing source: ${JSON.stringify(report.source)}` };
  }
  if (!report.sender || typeof report.sender !== 'string') {
    return { isValid: false, error: `Invalid or missing sender: ${JSON.stringify(report.sender)}` };
  }
  if (report.spamProbability !== undefined && (typeof report.spamProbability !== 'number' || report.spamProbability < 0 || report.spamProbability > 100)) {
    return { isValid: false, error: `Invalid spamProbability: ${JSON.stringify(report.spamProbability)}` };
  }
  if (report.hasExternalLink !== undefined && typeof report.hasExternalLink !== 'boolean') {
    return { isValid: false, error: `Invalid hasExternalLink: ${JSON.stringify(report.hasExternalLink)}` };
  }
  if (report.hasInternalLink !== undefined && typeof report.hasInternalLink !== 'boolean') {
    return { isValid: false, error: `Invalid hasInternalLink: ${JSON.stringify(report.hasInternalLink)}` };
  }
  if (report.modFlood !== undefined && (typeof report.modFlood !== 'number' || report.modFlood < 0)) {
    return { isValid: false, error: `Invalid modFlood: ${JSON.stringify(report.modFlood)}` };
  }
  if (report.modNotSpam !== undefined && (typeof report.modNotSpam !== 'number' || report.modNotSpam < 0)) {
    return { isValid: false, error: `Invalid modNotSpam: ${JSON.stringify(report.modNotSpam)}` };
  }

  return { isValid: true };
}

// -------------------- Функции кэширования и базы данных --------------------

async function checkCache(report: Report): Promise<Report | null> {
  try {
    const key = `report:${report.reportId}`;
    const cachedResult = await redis.get(key);
    if (cachedResult) {
      const cachedReport = JSON.parse(cachedResult) as Report;
      if (isReportIdentical(report, cachedReport)) {
        DEEP_LOG && log(`Cache hit for report ${report.reportId}`);
        return cachedReport;
      }
    }
    DEEP_LOG && log(`Cache miss for report ${report.reportId}`);
    return null;
  } catch (error) {
    logErr('checkCache', error);
    return null;
  }
}

function isReportIdentical(report1: Report, report2: Report): boolean {
  return report1.messageContent?.join('') === report2.messageContent?.join('') &&
         JSON.stringify(report1.mediaHashes) === JSON.stringify(report2.mediaHashes) &&
         report1.complaintCount === report2.complaintCount;
}

async function saveToCache(report: Report) {
  try {
    const key = `report:${report.reportId}`;
    const value = JSON.stringify({
      ...report,
      cachedAt: new Date().toISOString()
    });
    await redis.set(key, value, 'EX', 86400 * 7); // Кэш на 7 дней
    DEEP_LOG && log(`Saved to cache: ${key}`);
  } catch (error) {
    logErr('saveToCache', error);
  }
}

async function saveReport(report: Report) {
  const validationResult = validateReport(report);
  if (!validationResult.isValid) {
    logErr('saveReport', validationResult.error || 'Report validation failed');
    return;
  }
  
  DEEP_LOG && log(`Saving report: ${report.reportId}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const query = `
    INSERT INTO reports (
      report_id, message_content, media_hashes, complaint_count, source, sender,
      spam_probability, has_external_link, has_internal_link,
      mod_flood, mod_not_spam, is_spam, reason, created_at
    ) 
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 
      to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'DD.MM.YY, HH24:MI:SS'))
    ON CONFLICT (report_id) 
    DO UPDATE SET
      message_content = EXCLUDED.message_content,
      media_hashes = EXCLUDED.media_hashes,
      complaint_count = EXCLUDED.complaint_count,
      source = EXCLUDED.source,
      sender = EXCLUDED.sender,
      spam_probability = EXCLUDED.spam_probability,
      has_external_link = EXCLUDED.has_external_link,
      has_internal_link = EXCLUDED.has_internal_link,
      mod_flood = EXCLUDED.mod_flood,
      mod_not_spam = EXCLUDED.mod_not_spam,
      is_spam = EXCLUDED.is_spam,
      reason = EXCLUDED.reason,
      created_at = EXCLUDED.created_at
    `;

    const values = [
      report.reportId,
      report.messageContent,
      report.mediaHashes,
      report.complaintCount,
      report.source,
      report.sender,
      report.spamProbability,
      report.hasExternalLink,
      report.hasInternalLink,
      report.modFlood,
      report.modNotSpam,
      report.isSpam,
      report.reason
    ];
    await client.query(query, values);
    await client.query('COMMIT');
    DEEP_LOG && log(`Report saved successfully: ${report.reportId}`);

    // Синхронизация с кэшем
    await saveToCache(report);
  } catch (error) {
    await client.query('ROLLBACK');
    logErr('saveReport', error);
  } finally {
    client.release();
  }
}

async function transferDataFromRedisToPostgres() {
  const keys = await redis.keys('report:*');
  const pgClient = await pool.connect();

  try {
    await pgClient.query('BEGIN');

    for (const key of keys) {
      const value = await redis.get(key);
      if (value) {
        const report = JSON.parse(value) as Report;
        await saveReport(report);
      }
    }

    await pgClient.query('COMMIT');
    DEEP_LOG && log(`Transferred ${keys.length} records from Redis to PostgreSQL`);
  } catch (error) {
    await pgClient.query('ROLLBACK');
    throw error;
  } finally {
    pgClient.release();
  }
}

// -------------------- Утилиты и вспомогательные функции --------------------

function getProcessingInterval(): number {
  return parseInt(process.env.PROCESSING_INTERVAL || '1000', 10);
}

async function processNextReport() {
  if (!autoMode) {
    DEEP_LOG && log('Automatic mode is off, skipping report processing');
    return;
  }

  if (isProcessing || reportQueue.length === 0) return;

  isProcessing = true;
  const report = reportQueue.shift();

  if (report) {
    await new Promise(resolve => setTimeout(resolve, getProcessingInterval()));
    await processReport(report);
    
    await sendToBot("/next");
  }

  isProcessing = false;
  processNextReport(); // Обработка следующего отчета в очереди
}

async function ensureMinimumInterval(startTime: number, minInterval: number): Promise<void> {
  const elapsedTime = Date.now() - startTime;
  if (elapsedTime < minInterval) {
    await new Promise(resolve => setTimeout(resolve, minInterval - elapsedTime));
  }
}

async function reconnectClient() {
  try {
    DEEP_LOG && log('Attempting to reconnect Telegram client...');
    if (client) {
      await client.disconnect();
    }
    client = await initClient();
    DEEP_LOG && log('Telegram client reconnected successfully');
  } catch (error) {
    logErr('reconnectClient', error);
    throw new Error('Failed to reconnect Telegram client');
  }
}

async function notify(msg: string) {
  if (notifyAttempts >= MAX_NOTIFY_ATTEMPTS) {
    logger.error(`Failed to notify admin after ${MAX_NOTIFY_ATTEMPTS} attempts: ${msg}`);
    notifyAttempts = 0;
    return;
  }

  try {
    if (!client || !client.connected) {
      await reconnectClient();
    }

    DEEP_LOG && log(`Notifying admin: ${msg}`);
    await client.sendMessage(ADMIN_ID, { message: msg });
    DEEP_LOG && log(`Admin notified successfully: ${msg}`);
    notifyAttempts = 0;
  } catch (error) {
    notifyAttempts++;
    logErr('notify', error);
    DEEP_LOG && log(`Failed to notify admin: ${msg}. Attempt ${notifyAttempts}`);
    
    if (notifyAttempts < MAX_NOTIFY_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await notify(msg);
    }
  }
}

async function startAutoMode() {
  autoMode = true;
  log('Automatic mode activated');
  await sendToBot("/next");
  processNextReport();
}

function stopAutoMode() {
  autoMode = false;
  reportQueue.length = 0;
  log('Automatic mode deactivated and report queue cleared');
}

async function sendStatus() {
  const status = `
Current status:
Auto mode: ${autoMode ? 'On' : 'Off'}
Processing delay: ${getProcessingInterval()} ms
Database connection: ${await checkDB() ? 'Connected' : 'Disconnected'}
Reports in database: ${await checkDBContent()}
  `;
  await notify(status);
}

async function handleDbExport() {
  DEEP_LOG && log('Admin requested database export');
  try {
    const filename = await exportCSV();
    const fileStats = await fs.promises.stat(filename);
    await client.sendFile(ADMIN_ID, {
      file: filename,
      caption: `Database export: ${filename}\nSize: ${fileStats.size} bytes`,
    });
    await fs.promises.unlink(filename);
    DEEP_LOG && log('Database export sent to admin');
  } catch (error) {
    logErr('handleDbExport', error);
    await notify('Failed to export database. Check logs for details.');
  }
}

async function exportCSV(): Promise<string> {
  const client = await pool.connect();
  try {
    DEEP_LOG && log('Executing database query for export...');
    const result = await client.query('SELECT * FROM reports');
    DEEP_LOG && log(`Query executed. Found ${result.rows.length} rows.`);

    const filename = `reports_export_${Date.now()}.csv`;
    const csvWriter = createObjectCsvWriter({
      path: filename,
      header: [
        { id: 'id', title: 'ID' },
        { id: 'report_id', title: 'Report ID' },
        { id: 'message_content', title: 'Message Content' },
        { id: 'media_hashes', title: 'Media Hashes' },
        { id: 'complaint_count', title: 'Complaint Count' },
        { id: 'source', title: 'Source' },
        { id: 'sender', title: 'Sender' },
        { id: 'spam_probability', title: 'Spam Probability' },
        { id: 'has_external_link', title: 'Has External Link' },
        { id: 'has_internal_link', title: 'Has Internal Link' },
        { id: 'mod_flood', title: 'Mod Flood' },
        { id: 'mod_not_spam', title: 'Mod Not Spam' },
        { id: 'is_spam', title: 'Is Spam' },
        { id: 'reason', title: 'Reason' },
        { id: 'created_at', title: 'Created At' }
      ]
    });

    await csvWriter.writeRecords(result.rows);
    DEEP_LOG && log(`CSV file created: ${filename}`);
    return filename;
  } catch (error) {
    logErr('exportCSV', error);
    throw error;
  } finally {
    client.release();
  }
}

async function checkDB() {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT NOW()');
    DEEP_LOG && log(`Database connection successful. Current time: ${result.rows[0].now}`);
    return true;
  } catch (error) {
    logErr('checkDB', error);
    return false;
  } finally {
    client.release();
  }
}

async function checkDBSettings() {
  const client = await pool.connect();
  try {
    DEEP_LOG && log('Checking database settings...');
    const result = await client.query('SHOW ALL');
    const settings = result.rows.reduce((acc: Record<string, string>, row: { name: string; setting: string }) => {
      acc[row.name] = row.setting;
      return acc;
    }, {});
    DEEP_LOG && log(`Database settings: ${JSON.stringify(settings, null, 2)}`);
    return settings;
  } catch (error) {
    logErr('checkDBSettings', error);
    return null;
  } finally {
    client.release();
  }
}

async function checkDBContent() {
  const client = await pool.connect();
  try {
    DEEP_LOG && log('Checking database content...');
    const result = await client.query('SELECT COUNT(*) FROM reports');
    const count = parseInt(result.rows[0].count);
    DEEP_LOG && log(`Database contains ${count} reports`);
    if (count > 0) {
      const sampleResult = await client.query('SELECT * FROM reports LIMIT 1');
      DEEP_LOG && log(`Sample report: ${JSON.stringify(sampleResult.rows[0], null, 2)}`);
    }
    return count;
  } catch (error) {
    logErr('checkDBContent', error);
    return null;
  } finally {
    client.release();
  }
}

async function sendToBot(message: string) {
  if (!botEntity) throw new Error('Bot entity not initialized');
  try {
    await client.sendMessage(botEntity, { message });
    DEEP_LOG && log(`Message sent to bot: ${message}`);
  } catch (error) {
    logErr('sendToBot', error);
  }
}

async function sendDecision(decision: string) {
  if (!botEntity) throw new Error('Bot entity not initialized');
  try {
    await client.sendMessage(botEntity, { message: decision });
    DEEP_LOG && log(`Decision sent to bot: ${decision}`);
  } catch (error) {
    logErr('sendDecision', error);
  }
}

// -------------------- Основная функция --------------------

async function main() {
  try {
    DEEP_LOG && log('Starting application...');

    await initDB();
    DEEP_LOG && log('Database initialized');

    const isConnected = await checkDB();
    if (!isConnected) throw new Error('Failed to connect to the database');
    DEEP_LOG && log('Database connection confirmed');

    const dbSettings = await checkDBSettings();
    if (dbSettings) {
      DEEP_LOG && log('Database settings checked successfully');
    } else {
      logErr('main', 'Failed to check database settings');
    }

    try {
      client = await initClient();
      DEEP_LOG && log('Telegram client initialized');
    } catch (error) {
      logErr('main - initClient', error);
      throw new Error('Failed to initialize Telegram client');
    }

    await initBot();
    DEEP_LOG && log('Bot initialized');

    await setupHandlers();
    DEEP_LOG && log('Event handlers set up');

    app.listen(PORT, () => log(`Server running on port ${PORT}`));

    // Установка ежедневного сохранения данных из Redis в PostgreSQL
    schedule.scheduleJob('0 23 * * *', async () => {
      DEEP_LOG && log('Starting daily data transfer from Redis to PostgreSQL');
      try {
        await transferDataFromRedisToPostgres();
        DEEP_LOG && log('Daily data transfer completed successfully');
      } catch (error) {
        logErr('Daily data transfer', error);
        await notify('Failed to transfer data from Redis to PostgreSQL. Check logs for details.');
      }
    });

    // Установка периодических проверок
    setInterval(async () => {
      const isStillConnected = await checkDB();
      if (!isStillConnected) {
        logErr('main', 'Lost connection to the database. Attempting to reconnect...');
        await initDB();
      }
    }, DB_CHECK_INTERVAL);

    setInterval(async () => {
      DEEP_LOG && log('Performing periodic health check...');
      await checkDB();
      const reportCount = await checkDBContent();
      DEEP_LOG && log(`Current number of reports in database: ${reportCount}`);
    }, HEALTH_CHECK_INTERVAL);

    // Добавляем периодическую проверку соединения с Telegram
    setInterval(async () => {
      if (!client || !client.connected) {
        DEEP_LOG && log('Lost connection to Telegram. Attempting to reconnect...');
        await reconnectClient();
      }
    }, 60000); // Проверяем каждую минуту

    await notify('Application initialized successfully');

    // Обработка ошибок
    process.on('unhandledRejection', (reason, promise) => {
      logErr('UnhandledRejection', `Reason: ${reason}`);
    });

    process.on('uncaughtException', (error) => {
      logErr('UncaughtException', error);
      setTimeout(() => process.exit(1), 1000);
    });

    process.on('SIGINT', async () => {
      log('Shutting down gracefully');
      await gracefulShutdown();
    });

    process.on('SIGTERM', async () => {
      log('Received SIGTERM. Shutting down gracefully');
      await gracefulShutdown();
    });

  } catch (error) {
    logErr('main', error);
    process.exit(1);
  }
}

async function gracefulShutdown() {
  log('Starting graceful shutdown...');

  // Остановка автоматического режима
  stopAutoMode();

  // Закрытие соединения с базой данных
  try {
    await pool.end();
    log('Database connection closed');
  } catch (error) {
    logErr('gracefulShutdown - closing database connection', error);
  }

  // Отключение клиента Telegram
  try {
    if (client) {
      await client.disconnect();
      log('Telegram client disconnected');
    }
  } catch (error) {
    logErr('gracefulShutdown - disconnecting Telegram client', error);
  }

  // Закрытие соединения с Redis
  try {
    await redis.quit();
    log('Redis connection closed');
  } catch (error) {
    logErr('gracefulShutdown - closing Redis connection', error);
  }

  log('Graceful shutdown completed');
  process.exit(0);
}

// Запуск приложения
main().catch(error => {
  logErr('main function', error);
  process.exit(1);
});