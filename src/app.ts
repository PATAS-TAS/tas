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
import { createObjectCsvWriter } from 'csv-writer';
import winston from 'winston';

// Загрузка переменных окружения
dotenv.config();

// Константы и конфигурация
const DEEP_LOG = process.env.DEEP_LOG === 'true';
const PORT = process.env.PORT || 3000;
const ADMIN_ID = parseInt(process.env.ADMIN_ID!, 10);
const DB_URL = process.env.DATABASE_URL!;
const API_ID = parseInt(process.env.API_ID!, 10);
const API_HASH = process.env.API_HASH!;
const SESSION_STRING = process.env.SESSION_STRING!;
const BOT_ID = process.env.BOT_ID!;
const BOT_ACCESS_HASH = process.env.BOT_ACCESS_HASH!;
const DB_CHECK_INTERVAL = parseInt(process.env.DB_CHECK_INTERVAL || '60000', 10);
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '300000', 10);

const app = express();
const { Pool } = pkg;

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

// Функции логирования
const log = (msg: string) => logger.info(msg);
const logErr = (ctx: string, err: unknown) => {
  const errMsg = err instanceof Error ? err.message : String(err);
  logger.error(`Error in ${ctx}: ${errMsg}`);
  notify(`Error in ${ctx}: ${errMsg}`).catch(e => 
    logger.error(`Failed to notify admin: ${e instanceof Error ? e.message : String(e)}`)
  );
};

// Интерфейсы
interface Report {
  reportId: string;
  messageContent: string[];
  mediaHashes: string[];
  complaintCount: number;
  source: string;
  sender: string;
  spamProbability?: number;
  hasExternalLink: boolean;
  hasInternalLink: boolean;
  modFlood: number;
  modNotSpam: number;
  manualClassification?: string;
}

interface ValidationResult {
  isValid: boolean;
  error?: string;
}

// Глобальные переменные
let client: TelegramClient;
let botEntity: Api.InputPeerUser | null = null;
let currentReport: Partial<Report> = {};

// Инициализация пула соединений с базой данных
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Регулярные выражения для парсинга системных сообщений
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

// Инициализация Telegram клиента
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

// Инициализация базы данных
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
        manual_classification TEXT,
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

// Инициализация бота
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

// Обработка проверочных сообщений
async function handleCheck(event: NewMessageEvent) {
  const message = event.message;
  if (
    message instanceof Api.Message &&
    event.isPrivate &&
    botEntity &&
    message.senderId?.toString() === botEntity.userId.toString()
  ) {
    DEEP_LOG && log(`Received message for check: ${message.message}`);
    
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

// Предобработка сообщения
function preprocessMessage(message: string): string {
  return message.split('\n').slice(1).join('\n');
}

// Обработка системных сообщений
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
    
    currentReport = { ...currentReport, ...sysInfo };
    DEEP_LOG && log(`Current report after merging: ${JSON.stringify(currentReport, null, 2)}`);
    
    if (!currentReport.reportId) {
      log('Warning: reportId is missing in the current report');
    } else {
      DEEP_LOG && log(`Report ID found: ${currentReport.reportId}`);
    }
    
    const validationResult = validateReport(currentReport as Report);
    if (validationResult.isValid) {
      await saveReport(currentReport as Report);
      DEEP_LOG && log(`Report saved: ${JSON.stringify(currentReport, null, 2)}`);
      currentReport = {};
      DEEP_LOG && log('Current report reset');
    } else {
      log(`Report validation failed: ${validationResult.error}`);
      DEEP_LOG && log(`Invalid report data: ${JSON.stringify(currentReport, null, 2)}`);
    }
  }
}

// Обработка ручной классификации
async function handleManual(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && !event.isPrivate && botEntity && message.peerId?.toString() === botEntity.userId.toString()) {
    const classification = message.message || '';
    log(`Manual classification sent: ${classification}`);
    if (classification === "😡 SPAM" || classification === "😌 NO") {
      currentReport.manualClassification = classification;
      if (isValidReport(currentReport as Report)) {
        await saveReport(currentReport as Report);
        currentReport = {};
        log(`Report saved with manual classification: ${classification}`);
      } else {
        log('Current report is not valid, manual classification not saved');
      }
    } else {
      log(`Received message is not a valid classification: ${classification}`);
    }
  }
}

// Парсинг системного сообщения
function parseSysMsg(msg: string): Partial<Report> {
  const info: Partial<Report> = {
    modFlood: 0,
    modNotSpam: 0,
    hasExternalLink: false,
    hasInternalLink: false
  };
  
  const reportIdMatch = msg.match(sysRegex.reportId);
  if (reportIdMatch) info.reportId = reportIdMatch[1];
  
  const complaintMatch = msg.match(sysRegex.complaintCount);
  if (complaintMatch) info.complaintCount = parseInt(complaintMatch[1]);
  
  info.hasExternalLink = sysRegex.externalLink.test(msg);
  info.hasInternalLink = sysRegex.internalLink.test(msg);
  
  const sourceMatch = msg.match(sysRegex.source);
  if (sourceMatch) info.source = sourceMatch[1].trim();
  
  const senderMatch = msg.match(sysRegex.sender);
  if (senderMatch) info.sender = senderMatch[1].trim();
  
  const spamProbMatch = msg.match(sysRegex.spamProbability);
  if (spamProbMatch) info.spamProbability = parseInt(spamProbMatch[1]);
  
  // Обработка решений модераторов
  const lines = msg.split('\n');
  for (const line of lines) {
    if (sysRegex.modFlood.test(line)) {
      info.modFlood = (info.modFlood || 0) + 1;
    }
    if (sysRegex.modNotSpam.test(line)) {
      info.modNotSpam = (info.modNotSpam || 0) + 1;
    }
  }
  
  // Ограничиваем значения modFlood и modNotSpam до 2
  if (info.modFlood) info.modFlood = Math.min(info.modFlood, 2);
  if (info.modNotSpam) info.modNotSpam = Math.min(info.modNotSpam, 2);
  
  return info;
}

// Получение хеша медиа-контента
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

// Валидация отчета
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
  if (report.modFlood !== undefined && (typeof report.modFlood !== 'number' || report.modFlood < 0 || report.modFlood > 2)) {
    return { isValid: false, error: `Invalid modFlood: ${JSON.stringify(report.modFlood)}` };
  }
  if (report.modNotSpam !== undefined && (typeof report.modNotSpam !== 'number' || report.modNotSpam < 0 || report.modNotSpam > 2)) {
    return { isValid: false, error: `Invalid modNotSpam: ${JSON.stringify(report.modNotSpam)}` };
  }
  
  return { isValid: true };
}

// Проверка валидности отчета
function isValidReport(report: Partial<Report>): boolean {
  return validateReport(report).isValid;
}

// Сохранение отчета в базу данных
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
      mod_flood, mod_not_spam, manual_classification, created_at
    ) 
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 
      to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'DD.MM.YY, HH24:MI:SS'))
    ON CONFLICT (report_id) 
    DO UPDATE SET
      message_content = COALESCE(EXCLUDED.message_content, reports.message_content),
      media_hashes = COALESCE(EXCLUDED.media_hashes, reports.media_hashes),
      complaint_count = COALESCE(EXCLUDED.complaint_count, reports.complaint_count),
      source = COALESCE(EXCLUDED.source, reports.source),
      sender = COALESCE(EXCLUDED.sender, reports.sender),
      spam_probability = EXCLUDED.spam_probability,
      has_external_link = COALESCE(EXCLUDED.has_external_link, reports.has_external_link),
      has_internal_link = COALESCE(EXCLUDED.has_internal_link, reports.has_internal_link),
      mod_flood = GREATEST(reports.mod_flood, EXCLUDED.mod_flood),
      mod_not_spam = GREATEST(reports.mod_not_spam, EXCLUDED.mod_not_spam),
      manual_classification = COALESCE(EXCLUDED.manual_classification, reports.manual_classification),
      created_at = CASE
        WHEN reports.created_at IS NULL THEN EXCLUDED.created_at
        ELSE reports.created_at
      END
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
      report.manualClassification
    ];
    await client.query(query, values);
    await client.query('COMMIT');
    DEEP_LOG && log(`Report saved successfully: ${report.reportId}`);
  } catch (error) {
    await client.query('ROLLBACK');
    logErr('saveReport', error);
  } finally {
    client.release();
  }
}

// Уведомление администратора
async function notify(msg: string) {
  try {
    DEEP_LOG && log(`Notifying admin: ${msg}`);
    await client.sendMessage(ADMIN_ID, { message: msg });
    DEEP_LOG && log(`Admin notified successfully: ${msg}`);
  } catch (error) {
    logErr('notify', error);
    DEEP_LOG && log(`Failed to notify admin: ${msg}`);
  }
}

// Обработка сообщений администратора
async function handleAdmin(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && message.senderId?.toString() === ADMIN_ID.toString()) {
    DEEP_LOG && log(`Received admin message: ${message.message}`);
    if (message.message === '/db') {
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
        logErr('handleAdmin - database export', error);
        await notify('Failed to export database. Check logs for details.');
      }
    } else {
      DEEP_LOG && log(`Unrecognized admin command: ${message.message}`);
    }
  }
}

// Настройка обработчиков событий
async function setupHandlers() {
  if (!botEntity) throw new Error('Bot entity not initialized');
  const botUserId = botEntity.userId.toJSNumber();

  const handlers = [
    { handler: handleCheck, options: { fromUsers: [botUserId], incoming: true, forwards: true } },
    { handler: handleSys, options: { fromUsers: [botUserId], incoming: true, pattern: /😱\d+/ } },
    { handler: handleManual, options: { outgoing: true, chats: [botUserId] } },
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

// Экспорт данных в CSV
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
        { id: 'manual_classification', title: 'Manual Classification' },
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

// Проверка соединения с базой данных
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

// Проверка настроек базы данных
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

// Проверка содержимого базы данных
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

// Основная функция
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

    client = await initClient();
    DEEP_LOG && log('Telegram client initialized');

    await initBot();
    DEEP_LOG && log('Bot initialized');

    await setupHandlers();
    DEEP_LOG && log('Event handlers set up');

    app.listen(PORT, () => log(`Server running on port ${PORT}`));

    if (botEntity) {
      try {
        await client.sendMessage(botEntity, { message: "/next" });
        log('Initial message sent to bot');
      } catch (error) {
        logErr('main - sending initial message to bot', error);
      }
    } else {
      throw new Error('Bot entity not initialized');
    }

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
      await pool.end();
      await client.disconnect();
      process.exit(0);
    });

  } catch (error) {
    logErr('main', error);
    process.exit(1);
  }
}

// Запуск приложения
main().catch(error => {
  logErr('main function', error);
  process.exit(1);
});