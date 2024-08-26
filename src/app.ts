import { NewMessage, NewMessageEvent } from 'telegram/events/NewMessage.js';
import { StringSession } from 'telegram/sessions/index.js';
import { createObjectCsvWriter } from 'csv-writer';
import { TelegramClient } from 'telegram/index.js';
import { Api } from 'telegram/tl/index.js';
import schedule from 'node-schedule';
import bigInt from "big-integer";
import winston from 'winston';
import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import OpenAI from 'openai';
import Redis from 'ioredis';
import path from 'path';
import pkg from 'pg';
import fs from 'fs';
import { Mutex } from 'async-mutex';
import natural from 'natural';
import v8 from 'v8';

declare const global: {
  gc?: () => void;
} & typeof globalThis;

dotenv.config();

const { Pool } = pkg;
const app = express();

// Environment variables and constants
const BOT_ID = process.env.BOT_ID!;
const PORT = process.env.PORT || 3000;
const API_HASH = process.env.API_HASH!;
const DB_URL = process.env.DATABASE_URL!;
const REDIS_URL = process.env.REDIS_URL!;
const DEEP_LOG = process.env.DEEP_LOG === 'true';
const VERY_DEEP_LOG = process.env.VERY_DEEP_LOG === 'true';
const API_ID = parseInt(process.env.API_ID!, 10);
const SESSION_STRING = process.env.SESSION_STRING!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const ADMIN_ID = parseInt(process.env.ADMIN_ID!, 10);
const BOT_ACCESS_HASH = process.env.BOT_ACCESS_HASH!;
const DB_CHECK_INTERVAL = parseInt(process.env.DB_CHECK_INTERVAL || '60000', 10);
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '300000', 10);
const DB_MAX_SIZE_MB = 900;
const DB_ARCHIVE_THRESHOLD = 0.8;
const MAX_MESSAGE_LENGTH = 2000;
const IDLE_TIMEOUT = 1 * 60 * 1000; // 1 minutes

// Initialize Redis client
const redis = new Redis.Redis(REDIS_URL, {
  retryStrategy: (times) => Math.min(times * 50, 2000),
  reconnectOnError: (err) => err.message.includes('READONLY'),
  enableOfflineQueue: true,
  maxRetriesPerRequest: 3,
  connectTimeout: 10000,
  keepAlive: 10000,
  family: 4,
  db: 0
});

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const tokenizer = new natural.WordTokenizer();

// Configure Winston logger
const logger = winston.createLogger({
  level: VERY_DEEP_LOG ? 'debug' : (DEEP_LOG ? 'verbose' : 'info'),
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console()
  ]
});

// Logging functions
const log = (msg: string) => logger.info(msg);
const logErr = (ctx: string, err: unknown) => {
  const errMsg = err instanceof Error ? err.message : String(err);
  logger.error(`Error in ${ctx}: ${errMsg}`);
  notify(`Error in ${ctx}: ${errMsg}`).catch(e => 
    logger.error(`Failed to notify admin: ${e instanceof Error ? e.message : String(e)}`)
  );
};

// Enums
enum Reason {
  NOT_SPAM = 0,
  OBVIOUS = 1,
  CACHED_RESULT = 2,
  MODERATOR_2_FLOOD = 3,
  MODERATOR_1_FLOOD = 4,
  MODERATOR_2_NOT_SPAM = 5,
  MODERATOR_1_NOT_SPAM = 6,
  GPT_SPAM = 7,
  GPT_NOT_SPAM = 8,
}

enum ReportProcessingState {
  IDLE,
  WAITING_FOR_MODERATOR_OPINION,
  WAITING_FOR_NEXT_REPORT
}

// Interfaces
interface Report {
  reportId: string;
  messageContent?: string[];
  mediaHashes?: string[];
  complaintCount: number;
  source: string;
  sender: string;
  isSpam: number;
  reason?: Reason;
  confidence?: number;
  corrected?: boolean;
  messages?: Api.Message[];
  created_at?: Date;
}

interface ValidationResult {
  isValid: boolean;
  error?: string;
}

interface SpamDecision {
  isSpam: number;
  reason: Reason;
  confidence?: number;
}

interface SysInfo {
  complaintCount: number;
  source: string;
  sender: string;
  reportId: string;
}

interface ModeratorOpinion {
  modFlood: number;
  modNotSpam: number;
}

interface CheckResult {
  isSpam: number;
  reason: Reason;
}

// Configuration object for different checks
const checkConfig = {
  obviousSpam: true,
  cache: true,
  gpt: true,
  moderators: true
};

// Global variables
let client: TelegramClient;
let botEntity: Api.InputPeerUser | null = null;
let currentReport: Partial<Report> = {};
let autoMode = false;
let isProcessing = false;
let notifyAttempts = 0;
let currentState: ReportProcessingState = ReportProcessingState.IDLE;
let PROCESSING_INTERVAL = parseInt(process.env.PROCESSING_INTERVAL || '100', 10);
let COMMAND_DELAY = parseInt(process.env.COMMAND_DELAY || '100', 10);
let lastProcessedReportId: string | null = null;
let reportQueue: Report[] = [];
let postgresQueue: Report[] = [];
let lastProcessingTime: number = Date.now();

const MAX_NOTIFY_ATTEMPTS = 3;
const dangEx = ['.exe', '.apk', '.bat', '.cmd', '.msi', '.vbs', '.js', '.scr', '.pif'];

// Initialize PostgreSQL pool
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Regular expressions for parsing system messages
const sysRegex = {
  reportId: /#r(\d+)/,
  complaintCount: /😱(\d+)/,
  source: /^(?:🗣\s*)?Source:\s*(.+)/m,
  sender: /^Sender:\s*(.+)/m,
  modFlood: /– Flood/,
  modNotSpam: /– Not Spam/
};

const POSTGRES_BATCH_SIZE = 100;

const processingMutex = new Mutex();
let processingStartTime: number | null = null;

// Utility functions
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function preprocessMessage(message: string): string {
  const processedMessage = message.split('\n').slice(1).join('\n');
  return processedMessage.length > MAX_MESSAGE_LENGTH ? processedMessage.slice(0, MAX_MESSAGE_LENGTH) : processedMessage;
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

async function getMediaHash(media: Api.TypeMessageMedia, replyMarkup?: Api.TypeReplyMarkup): Promise<string> {
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

  // Check for URL buttons
  if (replyMarkup && replyMarkup instanceof Api.ReplyInlineMarkup) {
    for (const row of replyMarkup.rows) {
      for (const button of row.buttons) {
        if (button instanceof Api.KeyboardButtonUrl) {
          return `url_button:${button.url}`;
        }
      }
    }
  }

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
  if (report.isSpam !== undefined && (report.isSpam !== 0 && report.isSpam !== 1)) {
    return { isValid: false, error: `Invalid isSpam: ${JSON.stringify(report.isSpam)}` };
  }
  if (report.reason !== undefined && !Object.values(Reason).includes(report.reason)) {
    return { isValid: false, error: `Invalid reason: ${JSON.stringify(report.reason)}` };
  }
  if (report.confidence !== undefined) {
    if (typeof report.confidence !== 'number' || report.confidence < 0 || report.confidence > 100) {
      return { isValid: false, error: `Invalid confidence: ${JSON.stringify(report.confidence)}` };
    }
  }

  return { isValid: true };
}

function isReportIdentical(report1: Report, report2: Report): boolean {
  return report1.messageContent?.join('') === report2.messageContent?.join('') &&
         JSON.stringify(report1.mediaHashes) === JSON.stringify(report2.mediaHashes) &&
         report1.complaintCount === report2.complaintCount;
}

async function saveToCache(report: Report) {
  try {
    const key = `report:${report.reportId}`;
    const valueToCache = {
      ...report,
      cachedAt: Date.now(),
      created_at: report.created_at ? report.created_at.toISOString() : new Date().toISOString()
    };

    const value = JSON.stringify(valueToCache);
    await redis.set(key, value, 'EX', 86400 * 3);
    await redis.zadd('report_timestamps', report.created_at?.getTime() || Date.now(), report.reportId);
    DEEP_LOG && log(`Saved to cache: ${key}`);
  } catch (error) {
    logErr('saveToCache', error);
  }
}

async function saveReport(report: Report) {
  const validationResult = validateReport(report);
  if (!validationResult.isValid) {
    const errorMessage = `Report validation failed for report ${report.reportId}: ${validationResult.error}`;
    logErr('saveReport', errorMessage);
    
    DEEP_LOG && log(`Invalid report data: ${JSON.stringify(report, null, 2)}`);
    
    await notify(`Validation error in report ${report.reportId}. Check logs for details.`);
    
    await saveInvalidReport(report, errorMessage);
    
    return;
  }
  
  const reportToSave: Report = {
    ...report,
    created_at: new Date()
  };
  
  DEEP_LOG && log(`Saving report to Redis: ${reportToSave.reportId}`);
  try {
    await saveToCache(reportToSave);
    DEEP_LOG && log(`Report saved successfully to Redis: ${reportToSave.reportId}`);
    
    postgresQueue.push(reportToSave);
    
    if (postgresQueue.length >= POSTGRES_BATCH_SIZE) {
      processPostgresQueue().catch(error => logErr('processPostgresQueue', error));
    }
  } catch (error) {
    logErr('saveReport - saving to Redis', error);
    postgresQueue.push(reportToSave);
  }
}

async function saveInvalidReport(report: Report, errorMessage: string) {
  try {
    const key = `invalid_report:${report.reportId}`;
    const value = JSON.stringify({
      report,
      error: errorMessage,
      timestamp: Date.now()
    });
    await redis.set(key, value, 'EX', 86400 * 7); // Store for 7 days
    DEEP_LOG && log(`Invalid report saved for analysis: ${key}`);
  } catch (error) {
    logErr('saveInvalidReport', error);
  }
}

async function checkInvalidReports() {
  const invalidReportKeys = await redis.keys('invalid_report:*');
  if (invalidReportKeys.length > 0) {
    const message = `Found ${invalidReportKeys.length} invalid report(s). Please review and address the validation issues.`;
    await notify(message);
    DEEP_LOG && log(message);
  }
}

function getMemoryUsage(): { used: number, total: number, percentUsed: number } {
  const heapStats = v8.getHeapStatistics();
  const used = heapStats.used_heap_size;
  const total = heapStats.total_heap_size;
  const percentUsed = (used / total) * 100;
  return { used, total, percentUsed };
}

async function checkAndManageMemory() {
  const memoryUsage = getMemoryUsage();
  DEEP_LOG && log(`Memory usage: ${memoryUsage.percentUsed.toFixed(2)}% (${(memoryUsage.used / 1024 / 1024).toFixed(2)} MB / ${(memoryUsage.total / 1024 / 1024).toFixed(2)} MB)`);

  if (memoryUsage.percentUsed > 80) {
    DEEP_LOG && log('Memory usage is high. Attempting to free up memory...');
    
    if (typeof global.gc === 'function') {
      global.gc();
      DEEP_LOG && log('Garbage collection called manually');
    } else {
      DEEP_LOG && log('Manual garbage collection is not available. Make sure to run Node.js with --expose-gc flag');
    }

    const newMemoryUsage = getMemoryUsage();
    DEEP_LOG && log(`Memory usage after cleanup attempt: ${newMemoryUsage.percentUsed.toFixed(2)}% (${(newMemoryUsage.used / 1024 / 1024).toFixed(2)} MB / ${(newMemoryUsage.total / 1024 / 1024).toFixed(2)} MB)`);
    
    if (newMemoryUsage.percentUsed > 90) {
      logErr('Memory Management', 'Memory usage is critically high even after cleanup attempt');
      await notify('Warning: Memory usage is critically high. The application will be restarted.');
      await gracefulShutdown(true);
    }
  }
}

async function cleanupOldData() {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  // Clean up old reports from Redis
  const oldKeys = await redis.zrangebyscore('report_timestamps', '-inf', oneDayAgo);
  if (oldKeys.length > 0) {
    await redis.zrem('report_timestamps', ...oldKeys);
    await redis.del(...oldKeys.map(key => `report:${key}`));
    DEEP_LOG && log(`Cleaned up ${oldKeys.length} old reports from Redis`);
  }

  // Clean up old data from queues
  reportQueue = reportQueue.filter(report => {
    const reportDate = report.created_at ? report.created_at.getTime() : now;
    return reportDate > oneDayAgo;
  });

  postgresQueue = postgresQueue.filter(report => {
    const reportDate = report.created_at ? report.created_at.getTime() : now;
    return reportDate > oneDayAgo;
  });

  DEEP_LOG && log(`Cleaned up reportQueue (${reportQueue.length} remaining) and postgresQueue (${postgresQueue.length} remaining)`);
  DEEP_LOG && log('Old data cleanup completed');
}

async function processPostgresQueue() {
  if (postgresQueue.length === 0) return;

  const batchToProcess = postgresQueue.splice(0, POSTGRES_BATCH_SIZE);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const report of batchToProcess) {
      await saveToPostgresWithTransaction(report, client);
    }

    await client.query('COMMIT');
    DEEP_LOG && log(`Batch of ${batchToProcess.length} reports saved to PostgreSQL`);
  } catch (error) {
    await client.query('ROLLBACK');
    logErr('processPostgresQueue', error);
    postgresQueue = [...batchToProcess, ...postgresQueue];
  } finally {
    client.release();
  }
}

async function saveToPostgresWithTransaction(report: Report, client: pkg.PoolClient): Promise<void> {
  DEEP_LOG && log(`Saving report to PostgreSQL: ${report.reportId}`);
  const query = `
    INSERT INTO reports (
      report_id, message_content, media_hashes, complaint_count, source, sender,
      is_spam, reason, corrected, confidence, created_at
    ) 
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (report_id, created_at) DO UPDATE SET
      message_content = EXCLUDED.message_content,
      media_hashes = EXCLUDED.media_hashes,
      complaint_count = EXCLUDED.complaint_count,
      source = EXCLUDED.source,
      sender = EXCLUDED.sender,
      is_spam = EXCLUDED.is_spam,
      reason = EXCLUDED.reason,
      corrected = EXCLUDED.corrected,
      confidence = EXCLUDED.confidence
  `;

  const values = [
    report.reportId,
    report.messageContent,
    report.mediaHashes,
    report.complaintCount,
    report.source,
    report.sender,
    report.isSpam,
    report.reason,
    report.corrected,
    report.confidence,
    report.created_at
  ];

  await client.query(query, values);
}

async function incrementalDataTransfer() {
  const lastTransferKey = 'last_transfer_timestamp';
  const lastTransfer = await redis.get(lastTransferKey) || '0';
  const currentTime = Date.now().toString();

  log('Starting incremental data transfer from Redis to PostgreSQL');
  try {
    await processPostgresQueue();

    const keys = await redis.zrangebyscore('report_timestamps', lastTransfer, currentTime);
    for (const key of keys) {
      const reportData = await redis.get(`report:${key}`);
      if (reportData) {
        const report = JSON.parse(reportData) as Report;
        postgresQueue.push(report);
        
        if (postgresQueue.length >= POSTGRES_BATCH_SIZE) {
          await processPostgresQueue();
        }
      }
    }

    if (postgresQueue.length > 0) {
      await processPostgresQueue();
    }

    await redis.set(lastTransferKey, currentTime);
    log('Incremental data transfer completed successfully');
  } catch (error) {
    logErr('Incremental data transfer', error);
    await notify('Failed to transfer data incrementally from Redis to PostgreSQL. Check logs for details.');
  }
}

const transferSchedules = ['0 */4 * * *', '0 23 * * *'];
transferSchedules.forEach(cronSchedule => {
  schedule.scheduleJob(cronSchedule, incrementalDataTransfer);
});

async function restoreFromPostgresToRedis() {
  log('Starting data restoration from PostgreSQL to Redis');
  let restoredCount = 0;
  let errorCount = 0;

  const client = await pool.connect();
  try {
    const lastTransfer = await redis.get('last_transfer_timestamp') || '0';
    const result = await client.query('SELECT * FROM reports WHERE created_at > $1', [lastTransfer]);
    
    for (const row of result.rows) {
      try {
        const report: Report = {
          reportId: row.report_id,
          messageContent: row.message_content,
          mediaHashes: row.media_hashes,
          complaintCount: row.complaint_count,
          source: row.source,
          sender: row.sender,
          isSpam: row.is_spam,
          reason: row.reason,
          confidence: row.confidence,
          corrected: row.corrected,
          created_at: row.created_at
        };

        await saveToCache(report);
        await redis.zadd('report_timestamps', new Date(row.created_at).getTime(), report.reportId);
        restoredCount++;
      } catch (error) { 
        logErr(`Error restoring report ${row.report_id} to Redis`, error);
        errorCount++;
      }
    }

    log(`Data restoration completed. Restored: ${restoredCount}, Errors: ${errorCount}`);
    
    if (errorCount > 0) {
      await notify(`Data restoration completed with errors. Restored: ${restoredCount}, Errors: ${errorCount}`);
    } else {
      await notify(`Data restoration completed successfully. Restored: ${restoredCount} reports.`);
    }
  } catch (error) {
    logErr('restoreFromPostgresToRedis', error);
    await notify('Failed to restore data from PostgreSQL to Redis. Check logs for details.');
  } finally {
    client.release();
  }
}

async function checkRedisAndRestore() {
  try {
    await redis.ping();
  } catch (error) {
    logErr('Redis connection lost', error);
    await notify('Lost connection to Redis. Attempting to reconnect and restore data...');
    
    redis.disconnect();
    await redis.connect();
    
    await restoreFromPostgresToRedis();
  }
}

async function checkDatabaseSize(): Promise<number> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT pg_database_size(current_database()) / (1024 * 1024) as size_mb;
    `);
    return parseFloat(result.rows[0].size_mb);
  } catch (error) {
    logErr('checkDatabaseSize', error);
    return 0;
  } finally {
    client.release();
  }
}

async function adaptiveArchiving(): Promise<void> {
  const currentSizeMB = await checkDatabaseSize();
  const usagePercentage = currentSizeMB / DB_MAX_SIZE_MB;

  if (usagePercentage >= DB_ARCHIVE_THRESHOLD) {
    log(`Database usage (${usagePercentage.toFixed(2)}%) exceeds threshold. Starting archiving process.`);
    await archiveOldData();
  } else {
    log(`Current database usage: ${usagePercentage.toFixed(2)}%. No archiving needed.`);
  }
}

async function archiveOldData(): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT created_at
      FROM reports
      ORDER BY created_at DESC
      OFFSET (SELECT COUNT(*) * $1 FROM reports)
      LIMIT 1
    `, [1 - DB_ARCHIVE_THRESHOLD]);

    if (result.rows.length === 0) {
      log('No data to archive');
      return;
    }

    const archiveDate = result.rows[0].created_at;
    
    const dataToArchive = await client.query(`
      SELECT * FROM reports
      WHERE created_at < $1
    `, [archiveDate]);
    
    if (dataToArchive.rows.length === 0) {
      log('No data to archive');
      return;
    }

    const filename = `archive_${new Date().toISOString().split('T')[0]}.csv`;
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
        { id: 'is_spam', title: 'Is Spam' },
        { id: 'reason', title: 'Reason' },
        { id: 'corrected', title: 'Corrected' },
        { id: 'confidence', title: 'Confidence' },
        { id: 'created_at', title: 'Created At' }
      ]
    });
    
    await csvWriter.writeRecords(dataToArchive.rows);
    
    await sendFileToAdmin(filename);
    
    await client.query(`
      DELETE FROM reports
      WHERE created_at < $1
    `, [archiveDate]);
    
    log(`Archived, sent to admin, and deleted ${dataToArchive.rows.length} records older than ${archiveDate.toISOString()}`);
    
    fs.unlinkSync(filename);
    
  } catch (error) {
    logErr('archiveOldData', error);
  } finally {
    client.release();
  }
}

async function sendFileToAdmin(filename: string): Promise<void> {
  try {
    const fileStats = await fs.promises.stat(filename);
    const caption = `Database archive: ${path.basename(filename)}\nSize: ${fileStats.size} bytes`;
    
    await client.sendFile(ADMIN_ID, {
      file: filename,
      caption: caption,
    });
    
    log(`Archive file sent to admin: ${filename}`);
  } catch (error) {
    logErr('sendFileToAdmin', error);
    await notify(`Failed to send archive file to admin: ${error instanceof Error ? error.message : String(error)}`);
  }
}

schedule.scheduleJob('0 2 * * *', () => {
  adaptiveArchiving().catch(error => logErr('Scheduled adaptive archiving', error));
});

function getProcessingInterval(): number {
  return parseInt(process.env.PROCESSING_INTERVAL || '100', 10);
}

async function processNextReport() {
  if (!autoMode) {
    DEEP_LOG && log('Automatic mode is off, skipping report processing');
    return;
  }

  if (reportQueue.length === 0) {
    isProcessing = false;
    return;
  }

  const report = reportQueue.shift();

  if (report) {
    try {
      await processReport(report);
    } catch (error) {
      logErr('processNextReport', error);
    } finally {
      setTimeout(processNextReport, getProcessingInterval());
    }
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

    if (autoMode) {
      await sendToBot("/next");
      setTimeout(checkProcessingStarted, 30000);
    }
  } catch (error) {
    logErr('reconnectClient', error);
    throw new Error('Failed to reconnect Telegram client');
  }
}

async function checkProcessingStarted() {
  if (reportQueue.length === 0 && !isProcessing) {
    DEEP_LOG && log('Processing not started after reconnect');
    await notify('Warning: Processing not started after reconnect. Please check the system.');
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
      await new Promise(resolve => setTimeout(resolve, 100));
      await notify(msg);
    }
  }
}

async function startAutoMode() {
  autoMode = true;
  isProcessing = true;
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
Check configuration:
- Obvious spam: ${checkConfig.obviousSpam ? 'On' : 'Off'}
- Cache: ${checkConfig.cache ? 'On' : 'Off'}
- GPT: ${checkConfig.gpt ? 'On' : 'Off'}
- Moderators: ${checkConfig.moderators ? 'On' : 'Off'}
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

    const filename = path.join(process.cwd(), `reports_export_${Date.now()}.csv`);
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
        { id: 'is_spam', title: 'Is Spam' },
        { id: 'reason', title: 'Reason' },
        { id: 'corrected', title: 'Corrected' },
        { id: 'confidence', title: 'Confidence' },
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

async function checkDatabaseIndexes() {
  const client = await pool.connect();
  try {
    const indexCheckQuery = `
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'reports'
        AND (indexname = 'idx_reports_is_spam_created_at' OR indexname = 'idx_reports_report_id');
    `;
    const indexCheckResult = await client.query(indexCheckQuery);
    const existingIndexes = indexCheckResult.rows.map(row => row.indexname);

    if (!existingIndexes.includes('idx_reports_is_spam_created_at')) {
      await client.query(`
        CREATE INDEX idx_reports_is_spam_created_at ON reports (is_spam, created_at);
      `);
    }
    if (!existingIndexes.includes('idx_reports_report_id')) {
      await client.query(`
        CREATE INDEX idx_reports_report_id ON reports (report_id);
      `);
    }

    const constraintCheckQuery = `
      SELECT constraint_name 
      FROM information_schema.table_constraints 
      WHERE table_name = 'reports' AND constraint_name = 'unique_report_id_created_at';
    `;
    const constraintCheckResult = await client.query(constraintCheckQuery);
    
    if (constraintCheckResult.rows.length === 0) {
      await client.query(`
        ALTER TABLE reports ADD CONSTRAINT unique_report_id_created_at UNIQUE (report_id, created_at);
      `);
    }

    await client.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_name = 'reports' AND column_name = 'confidence'
        ) THEN
          ALTER TABLE reports ADD COLUMN confidence FLOAT;
        END IF;
      END $$;
    `);
    
    log('Database indexes, constraints, and columns checked and updated if necessary');
  } catch (error) {
    logErr('checkDatabaseIndexes', error);
  } finally {
    client.release();
  }
}

async function sendToBot(message: string) {
  if (!botEntity) throw new Error('Bot entity not initialized');
  try {
    DEEP_LOG && log(`Attempting to send message to bot: ${message}`);
    await client.sendMessage(botEntity, { message });
    DEEP_LOG && log(`Message sent to bot successfully: ${message}`);
  } catch (error) {
    logErr('sendToBot', error);
  }
}

async function sendDecision(decision: string) {
  if (!botEntity) throw new Error('Bot entity not initialized');
  try {
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        client.sendMessage(botEntity!, { message: decision });
        DEEP_LOG && log(`Decision sent to bot: ${decision}`);
        resolve();
      }, 162);
    });
  } catch (error) {
    logErr('sendDecision', error);
  }
}

async function selectGptModel(message: string): Promise<string> {
  const tokenEstimate = message.split(/\s+/).length;
  if (tokenEstimate <= 100) return "gpt-4o-mini";
  else if (tokenEstimate <= 500) return "gpt-4o-2024-08-06";
  else return "gpt-4";
}

async function retryGptRequest<T>(
  requestFn: () => Promise<T>,
  maxRetries: number,
  baseDelay: number,
  maxDelay: number
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries reached');
}

async function checkObviousSpam(report: Report): Promise<SpamDecision | null> {
  if (!checkConfig.obviousSpam) return null;

  const messageContent = report.messageContent?.join('\n') || '';
  const lowercaseContent = messageContent.toLowerCase();

  // 1. Check for excessive use of emojis and unusual formatting
  const emojiCount = (messageContent.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
  const unusualFormattingCount = (messageContent.match(/[\uD835][\uDC00-\uDFFF]/g) || []).length;
  const textLength = messageContent.replace(/\s/g, '').length;
  if ((emojiCount + unusualFormattingCount) / textLength > 0.3) {
    return { isSpam: 1, reason: Reason.OBVIOUS };
  }

  // 2. Check for repetitive elements
  const words = messageContent.split(/\s+/);
  const wordCounts = words.reduce((acc, word) => {
    acc[word] = (acc[word] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const maxRepetitions = Math.max(...Object.values(wordCounts));
  const repeatingSymbolsMatch = messageContent.match(/(.)\1{4,}/);
  if (maxRepetitions > 3 || repeatingSymbolsMatch) {
    return { isSpam: 1, reason: Reason.OBVIOUS };
  }

  // 3. Check for multiple links and contact information
  const linkCount = (lowercaseContent.match(/https?:\/\/\S+/g) || []).length;
  const tMeLinkCount = (lowercaseContent.match(/t\.me\/\+?\w+/g) || []).length;
  const usernameCount = (messageContent.match(/@\w+/g) || []).length;
  if (linkCount + tMeLinkCount > 2 || (usernameCount > 1 && tMeLinkCount > 0)) {
    return { isSpam: 1, reason: Reason.OBVIOUS };
  }

  // 4. Check for excessive use of uppercase letters
  const uppercaseRatio = messageContent.replace(/[^a-zA-Z]/g, '').split('').filter(char => char === char.toUpperCase()).length / messageContent.replace(/[^a-zA-Z]/g, '').length;
  if (uppercaseRatio > 0.7 && messageContent.length > 20) {
    return { isSpam: 1, reason: Reason.OBVIOUS };
  }

  // 5. Check for suspicious message structure
  const lines = messageContent.split('\n');
  const singleWordLines = lines.filter(line => line.trim().split(/\s+/).length === 1);
  if (singleWordLines.length > 5 || (messageContent.length > 500 && (linkCount + tMeLinkCount > 0))) {
    return { isSpam: 1, reason: Reason.OBVIOUS };
  }

  // 6. Check for media or URL buttons with high complaint count
  if ((report.mediaHashes?.length || 
      report.mediaHashes?.some(hash => hash.startsWith('url_button:')) ||
      lowercaseContent.includes('https://') ||
      lowercaseContent.includes('http://') ||
      lowercaseContent.includes('t.me/') ||
      lowercaseContent.includes('www.') ||
      lowercaseContent.includes('.com') ||
      lowercaseContent.includes('.org') ||
      lowercaseContent.includes('.net') ||
      lowercaseContent.includes('@') || 
      lowercaseContent.match(/\+?[0-9]{10,14}/)) 
     && report.complaintCount > 2) {
    return { isSpam: 1, reason: Reason.OBVIOUS };
  }

  // 7. Check for stories
  if (lowercaseContent.includes('story') && report.mediaHashes?.some(hash => hash.startsWith('story:'))) {
    return { isSpam: 1, reason: Reason.OBVIOUS };
  }

  // 8. Check for dangerous file types
  if (report.mediaHashes?.some(hash => {
    const [mediaType, mediaId] = hash.split(':');
    if (mediaType === 'doc') {
      return dangEx.some(ext => mediaId.toLowerCase().endsWith(ext));
    }
    return false;
  })) {
    return { isSpam: 1, reason: Reason.OBVIOUS };
  }

  // 9. Check for URL buttons (InlineKeyboardButton)
  if (report.mediaHashes?.some(hash => hash.startsWith('url_button:'))) {
    return { isSpam: 1, reason: Reason.OBVIOUS };
  }

   // 10. Check for phone numbers with more than 2 complaints
   const phoneRegex = /(\+\d{1,3}[\s-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
   const phoneNumbers = messageContent.match(phoneRegex) || [];
   if ((phoneNumbers.length > 0 || report.mediaHashes?.some(hash => hash.startsWith('contact:'))) && report.complaintCount > 2) {
     return { isSpam: 1, reason: Reason.OBVIOUS };
   }

  return null;
}

async function getTopSpamPhrases(): Promise<Array<{phrase: string, score: number}>> {
  try {
    const client = await pool.connect();
    const result = await client.query(`
      SELECT r.message_content, r.complaint_count, 
             (SELECT COUNT(*) FROM reports WHERE is_spam = 0) as total_non_spam
      FROM reports r
      WHERE r.is_spam = 1
      AND r.created_at > NOW() - INTERVAL '30 days'
      LIMIT 10000
    `);
    client.release();

    const messages = result.rows;
    const totalNonSpam = messages[0]?.total_non_spam || 1;
    const phraseCount: { [key: string]: { spamCount: number, totalCount: number } } = {};

    messages.forEach(row => {
      let content = row.message_content;
      if (Array.isArray(content)) {
        content = content.join(' ');
      } else if (typeof content !== 'string') {
        content = String(content);
      }
      const tokens = tokenizer.tokenize(content.toLowerCase());
      for (let i = 0; i < tokens.length - 2; i++) {
        const phrase = tokens.slice(i, i + 3).join(' ');
        if (!phraseCount[phrase]) {
          phraseCount[phrase] = { spamCount: 0, totalCount: 0 };
        }
        phraseCount[phrase].spamCount += 1;
        phraseCount[phrase].totalCount += 1;
      }
    });

    const nonSpamResult = await client.query(`
      SELECT message_content
      FROM reports
      WHERE is_spam = 0
      AND created_at > NOW() - INTERVAL '30 days'
      LIMIT 10000
    `);

    nonSpamResult.rows.forEach(row => {
      let content = row.message_content;
      if (Array.isArray(content)) {
        content = content.join(' ');
      } else if (typeof content !== 'string') {
        content = String(content);
      }
      const tokens = tokenizer.tokenize(content.toLowerCase());
      for (let i = 0; i < tokens.length - 2; i++) {
        const phrase = tokens.slice(i, i + 3).join(' ');
        if (phraseCount[phrase]) {
          phraseCount[phrase].totalCount += 1;
        }
      }
    });

    const minOccurrences = 5;
    const sortedPhrases = Object.entries(phraseCount)
      .filter(([, counts]) => counts.spamCount >= minOccurrences)
      .map(([phrase, counts]) => ({
        phrase,
        score: (counts.spamCount / counts.totalCount) * Math.log(counts.spamCount)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);

    return sortedPhrases;
  } catch (error) {
    logErr('getTopSpamPhrases', error);
    return [];
  }
}

async function updateSpamPhrases() {
  try {
    const phrases = await getTopSpamPhrases();
    await redis.set('spam_phrases', JSON.stringify(phrases));
    log(`Spam phrases updated successfully. Total phrases: ${phrases.length}`);
  } catch (error) {
    logErr('updateSpamPhrases', error);
  }
}

schedule.scheduleJob('0 0 * * *', updateSpamPhrases);

async function checkCache(report: Report): Promise<SpamDecision | null> {
  if (!checkConfig.cache) return null;

  try {
    const key = `report:${report.reportId}`;
    const cachedResult = await redis.get(key);
    if (cachedResult) {
      const cachedReport = JSON.parse(cachedResult) as Report;
      if (isReportIdentical(report, cachedReport)) {
        DEEP_LOG && log(`Cache hit for report ${report.reportId}`);
        return { 
          isSpam: cachedReport.isSpam,
          reason: Reason.CACHED_RESULT,
          confidence: cachedReport.confidence
        };
      }
    }
    DEEP_LOG && log(`Cache miss for report ${report.reportId}`);
    return null;
  } catch (error) {
    logErr('checkCache', error);
    return null;
  }
}

async function checkGPT(report: Report, sysInfo: SysInfo): Promise<SpamDecision | null> {
  if (!checkConfig.gpt) {
    DEEP_LOG && log('GPT check is disabled');
    return null;
  }

  const model = await selectGptModel(report.messageContent?.join(' ') || '');
  const gptPrompt = `Analyze multilingual Telegram messages or system information for spam. Use provided context (complaints, source, sender). Classify as spam (1) or not spam (0) and provide a confidence score from 0 to 100.

  Spam (1) if clear:
  1. Commercial:
     - Unsolicited ads, subtle marketing
     - Self-promotion of unrelated channels/groups
     - Disguised promotions (e.g., informative messages with channel links)
  2. Scams/Financial:
     - Phishing, fake giveaways, get-rich-quick schemes
     - Unrealistic financial promises, urgent decisions
     - Suspicious cryptocurrency/airdrop mentions
     - Offers of quick money or short-term "jobs"
     3. Deceptive/Adult:
     - Impersonation, false promises
     - Explicit content, unsolicited services
     - Subtle invitations for private meetings, coded language
     - Requests for private photos/information
  4. Unwanted:
     - Chain messages, excessive invites
     - Unsolicited job offers, surveys, personal requests
     - Irrelevant business/political/religious messages
  5. Suspicious Behavior:
     - Bot-like messages, repetitive content
     - Attempts to move conversations to private channels
     - Excessive emojis, especially at line starts
     - Bypass attempts (e.g., unusual symbols)
  6. Harmful:
     - Incitement to violence/illegal activities
     - Sharing others' personal information
  
  Not Spam (0) for:
  1. Normal Interactions:
     - Greetings, casual conversation, jokes
     - Short messages, single words, numbers, or emojis (unless suspicious pattern)
     - Questions, replies, opinions, reactions
     - Any form of inquiry or response
  2. Legitimate Information:
     - Relevant news, educational content
     - Warnings about scams/spam (educational context)
  3. Group Activities:
     - Bot commands (starting with "/"), unless they have 3 or more complaints
     - Relevant polls
     - Political discussions (unless inciting violence or illegal activities)
     - Any message that could be relevant to a group's theme
  4. Expressive Language:
     - Profanity, crude language
     - Emotional outbursts or rants
     - Insults, arguments, or disagreements, even if very offensive or aggressive
  5. Cultural Content:
     - Local slang, cultural references/jokes
     - Regional news/events discussion
  6. Any message without clear spam indicators
  
  Key Factors:
  1. Message content and intent in any language
  2. Presence/nature of links or media
  3. Language tone and message structure
  4. Relevance to typical group conversations
  5. Provided context (complaints, source)
  
  For Ambiguous Cases:
  - Analyze overall message intent
  - Check for subtle solicitations or hidden promotions
  - Assess relevance of links/mentions
  - Consider cultural/linguistic context
  - Evaluate if message provides value or is promotional
  - Distinguish between spam discussions and actual spam
  - Offensive language or aggression alone are not indicators of spam
  
  Importantly:
  - Normal conversations, including casual chat and emoji usage, are not spam
  - Short messages are usually not spam unless part of a suspicious pattern
  - Group-related content should be considered in the context of the group's theme
  - Personal opinions or reactions are generally not spam
  - Business or financial discussions are allowed unless clearly scams or promotions
  - Messages with high complaint counts should be scrutinized carefully, but complaint count alone is not definitive proof of spam
  - Bot commands ("/") with 3 or more complaints should be carefully evaluated for spam potential
  - Sharing of links or information is not automatically spam, but context is crucial
  - Extremely offensive or aggressive language is not spam, but may violate other community guidelines
  - Be extra cautious with messages offering quick money or short-term "jobs", especially if they mention specific amounts
  
  Output: Two numbers separated by a comma. First number is classification (0 for not spam, 1 for spam), second is confidence score (0-100).`;

  let userPrompt: string;

  if (report.messageContent && report.messageContent.length > 0) {
    userPrompt = `Analyze message:
"${report.messageContent.join('\n')}"
Complaints: ${sysInfo.complaintCount}
Source: ${sysInfo.source}
Sender: ${sysInfo.sender}

Classification (0/1) and Confidence (0-100):`;
  } else {
    userPrompt = `Analyze system information:
Complaints: ${sysInfo.complaintCount}
Source: ${sysInfo.source}
Sender: ${sysInfo.sender}

Classification (0/1) and Confidence (0-100):`;
  }

  try {
    const response = await retryGptRequest(
      () => openai.chat.completions.create({
        model: model,
        messages: [
          { role: "system", content: gptPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 10,
        temperature: 0.1,
      }),
      2,
      30000,
      35000
    );

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('Empty GPT response');
    }

    const [classification, confidence] = content.split(',').map(Number);
    if (isNaN(classification) || isNaN(confidence) || (classification !== 0 && classification !== 1) || confidence < 0 || confidence > 100) {
      DEEP_LOG && log(`Unexpected GPT response: ${content}`);
      await sendToBot("/undo");
      await notify(`Unexpected GPT response for report ${sysInfo.reportId}: ${content}`);
      return null;
    }

    const isSpam = classification === 1;
    
    DEEP_LOG && log(`GPT decision: ${isSpam ? 'SPAM' : 'NOT SPAM'}, Confidence: ${confidence}%, Based on: ${report.messageContent ? 'Message content' : 'System information'}`);

    return {
      isSpam: isSpam ? 1 : 0,
      reason: isSpam ? Reason.GPT_SPAM : Reason.GPT_NOT_SPAM,
      confidence: confidence
    };
  } catch (error) {
    logErr('checkGPT', error);
    await sendToBot("/undo");
    await notify(`Error in GPT check for report ${sysInfo.reportId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function saveReportIdToRedis(reportId: string) {
  await redis.lpush('recent_report_ids', reportId);
  await redis.ltrim('recent_report_ids', 0, 9); // Keep only the last 10 reportIds
}

async function handleUndoProcess(initialReportId: string): Promise<boolean> {
  const recentReportIds = await redis.lrange('recent_report_ids', 0, -1);
  const startIndex = recentReportIds.indexOf(initialReportId);
  const processedReports = new Set<string>();
  const maxAttempts = 5; // Limit the number of attempts
  let attempts = 0;

  // Start from initialReportId if found, otherwise from the beginning of the list
  for (let i = startIndex !== -1 ? startIndex : 0; i < recentReportIds.length && attempts < maxAttempts; i++) {
    const reportId = recentReportIds[i];
    if (processedReports.has(reportId)) {
      continue;
    }

    processedReports.add(reportId);
    attempts++;

    const undoCommand = `/undo${reportId.replace(/\D/g, '')}`;
    DEEP_LOG && log(`Attempting undo for report ${reportId}`);
    await sendToBot(undoCommand);

    // Wait a short time to allow the bot to respond
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if the state or current report has changed
    if (currentState !== ReportProcessingState.WAITING_FOR_MODERATOR_OPINION || 
        currentReport.reportId !== reportId) {
      DEEP_LOG && log(`Successful undo for report ${reportId}`);
      return true; // Successful undo
    }
  }

  DEEP_LOG && log(`Failed to undo after ${attempts} attempts`);
  await notify(`Failed to undo after ${attempts} attempts. Bot will pause for 2 minutes.`);
  await pauseBot();
  return false;
}

async function pauseBot() {
  const previousAutoMode = autoMode;
  autoMode = false;
  isProcessing = false;
  DEEP_LOG && log('Bot paused for 2 minutes');
  await new Promise(resolve => setTimeout(resolve, 120000)); // 2 minutes
  autoMode = previousAutoMode;
  DEEP_LOG && log('Bot resumed operation');
  if (autoMode) {
    await sendToBot("/next");
  }
}

async function checkModerators(sysInfo: SysInfo): Promise<CheckResult | null> {
  const reportId = sysInfo.reportId;
  if (reportId !== currentReport.reportId) {
    console.log(`Mismatch in reportId: current ${currentReport.reportId}, received ${reportId}`);
    return null;
  }

  if (reportId === lastProcessedReportId) {
    DEEP_LOG && log(`Skipping moderator check for repeated report: ${reportId}`);
    return null;
  }

  DEEP_LOG && log(`Starting moderator check for report ${reportId}`);

  await delay(COMMAND_DELAY);
  await sendToBot("/stats");
  await delay(COMMAND_DELAY);
  await sendToBot(reportId);

  const moderatorOpinion = await new Promise<ModeratorOpinion | null>((resolve) => {
    const checkInterval = setInterval(async () => {
      const opinion = await redis.hgetall(`moderator_opinion:${reportId}`);
      DEEP_LOG && log(`Checking moderator opinion for ${reportId}: ${JSON.stringify(opinion)}`);
      if (opinion.modFlood !== undefined || opinion.modNotSpam !== undefined) {
        clearInterval(checkInterval);
        clearTimeout(timeoutId);
        
        resolve({
          modFlood: parseInt(opinion.modFlood || '0'),
          modNotSpam: parseInt(opinion.modNotSpam || '0')
        });
      }
    }, 500);

    const timeoutId = setTimeout(() => {
      clearInterval(checkInterval);
      DEEP_LOG && log(`Timeout reached while waiting for moderator opinion for ${reportId}`);
      resolve(null);
    }, 15000);
  });

  if (!moderatorOpinion) {
    DEEP_LOG && log(`No moderator opinion received for ${reportId}`);
    return null;
  }

  DEEP_LOG && log(`Received moderator opinion for ${reportId}: ${JSON.stringify(moderatorOpinion)}`);

  let decision: CheckResult | null;
  if (moderatorOpinion.modFlood >= 2) {
    decision = { isSpam: 1, reason: Reason.MODERATOR_2_FLOOD };
  } else if (moderatorOpinion.modNotSpam >= 2) {
    decision = { isSpam: 0, reason: Reason.MODERATOR_2_NOT_SPAM };
  } else if (moderatorOpinion.modFlood === 1 && moderatorOpinion.modNotSpam === 0) {
    decision = { isSpam: 1, reason: Reason.MODERATOR_1_FLOOD };
  } else if (moderatorOpinion.modNotSpam === 1 && moderatorOpinion.modFlood === 0) {
    decision = { isSpam: 0, reason: Reason.MODERATOR_1_NOT_SPAM };
  } else if (moderatorOpinion.modFlood === 1 && moderatorOpinion.modNotSpam === 1) {
    decision = null; // GPT will continue the check
  } else if (moderatorOpinion.modFlood === 0 && moderatorOpinion.modNotSpam === 0) {
    decision = null; // GPT will continue the check
  } else {
    DEEP_LOG && log(`Unexpected moderator opinion combination for ${reportId}`);
    const undoSuccess = await handleUndoProcess(reportId);
    if (!undoSuccess) {
      return null;
    }
    return null;
  }

  if (decision) {
    await redis.set(`final_decision:${reportId}`, JSON.stringify(decision), 'EX', 300); // Store for 5 minutes
    DEEP_LOG && log(`Saved decision to cache for ${reportId}: ${JSON.stringify(decision)}`);
  }

  DEEP_LOG && log(`Sending /next for report ${reportId}`);
  await sendToBot("/next");

  return decision;
}

async function processReport(report: Report): Promise<void> {
  const release = await processingMutex.acquire();
  try {
    if (report.reportId !== currentReport.reportId) {
      DEEP_LOG && log(`Mismatch in reportId: processing ${report.reportId}, current ${currentReport.reportId}`);
      return;
    }

    if (report.reportId === lastProcessedReportId) {
      DEEP_LOG && log(`Skipping repeated report: ${report.reportId}`);
      await sendToBot("/next");
      return;
    }

    processingStartTime = Date.now();
    isProcessing = true;

    const mediaTypes = report.messages?.map(m => m.media ? getMediaType(m.media) : 'None') || [];
    log(`Processing Report: ${report.reportId}, Messages: ${report.messages?.length || 0}, Media: ${mediaTypes.join(', ')}, Complaints: ${report.complaintCount}`);
    log(`Message content: ${report.messageContent?.join('\n').substring(0, 500)}${report.messageContent && report.messageContent.join('\n').length > 500 ? '...' : ''}`);

    const sysInfo: SysInfo = {
      complaintCount: report.complaintCount,
      source: report.source,
      sender: report.sender,
      reportId: report.reportId
    };

    let decision: SpamDecision | null = null;

    // 1. Check for obvious spam
    if (checkConfig.obviousSpam) {
      decision = await checkObviousSpam(report);
      if (decision) {
        DEEP_LOG && log(`Obvious spam detected: ${decision.reason}`);
      }
    }

    // 2. Check cache
    if (!decision && checkConfig.cache) {
      decision = await checkCache(report);
      if (decision) {
        DEEP_LOG && log(`Using cached result: ${decision.isSpam ? 'SPAM' : 'NOT SPAM'}`);
      }
    }

    // 3. Check moderators
    if (!decision && checkConfig.moderators) {
      DEEP_LOG && log(`Calling checkModerators for report ${report.reportId}`);
      const moderatorDecision = await checkModerators(sysInfo);
      if (moderatorDecision) {
        decision = {
          isSpam: moderatorDecision.isSpam,
          reason: moderatorDecision.reason
        };
        DEEP_LOG && log(`Moderator decision for ${report.reportId}: ${decision.isSpam ? 'SPAM' : 'NOT SPAM'}`);
      } else {
        DEEP_LOG && log(`No moderator decision for ${report.reportId}, proceeding to GPT check`);
      }
    }

    // 4. Check GPT
    if (!decision && checkConfig.gpt) {
      decision = await checkGPT(report, sysInfo);
      if (decision) {
        DEEP_LOG && log(`GPT decision: ${decision.isSpam ? 'SPAM' : 'NOT SPAM'}, Confidence: ${decision.confidence}%`);
      }
    }
  
    // Save the decision to cache
    if (decision) {
      await redis.set(`final_decision:${report.reportId}`, JSON.stringify(decision), 'EX', 300);
      DEEP_LOG && log(`Saved final decision to cache for ${report.reportId}: ${JSON.stringify(decision)}`);
    }
  
    // Send the decision
    if (decision) {
      await sendDecision(decision.isSpam ? '😡 SPAM' : '😌 NO');
      await saveReport({ ...report, ...decision, confidence: decision.confidence });
      log(`Decision for report ${report.reportId}: ${decision.isSpam ? 'SPAM' : 'NOT SPAM'}`);
    } else {
      DEEP_LOG && log("No decision made, sending /undo");
      await sendToBot("/undo");
    }

    lastProcessedReportId = report.reportId;
    lastProcessingTime = Date.now();

  } catch (error: unknown) {
    console.error("Error processing report:", error);
    if (error instanceof Error) {
      await notify(`Error processing report: ${error.message}`);
    } else {
      await notify(`Error processing report: ${String(error)}`);
    }
    await sendToBot("/undo");
  } finally {
    isProcessing = false;
    processingStartTime = null;
    release();

    DEEP_LOG && log(`Processing ended at: ${new Date().toISOString()}`);
    
    if (reportQueue.length > 0) {
      setImmediate(() => processNextReport().catch(error => {
        console.error("Error processing next report:", error);
      }));
    }
  }
}

function parseSysMsg(msg: string): Partial<Report> {
  const info: Partial<Report> = {
    complaintCount: 0,
    isSpam: 0
  };

  const reportIdMatch = msg.match(sysRegex.reportId);
  if (reportIdMatch) info.reportId = reportIdMatch[0];

  const complaintMatch = msg.match(sysRegex.complaintCount);
  if (complaintMatch) info.complaintCount = parseInt(complaintMatch[1]);

  const sourceMatch = msg.match(sysRegex.source);
  if (sourceMatch) info.source = sourceMatch[1].trim();

  const senderMatch = msg.match(sysRegex.sender);
  if (senderMatch) info.sender = senderMatch[1].trim();

  const lines = msg.split('\n');
  let modFloodCount = 0;
  let modNotSpamCount = 0;
  for (const line of lines) {
    if (sysRegex.modFlood.test(line)) {
      modFloodCount++;
    }
    if (sysRegex.modNotSpam.test(line)) {
      modNotSpamCount++;
    }
  }

  if (modFloodCount >= 2) {
    info.reason = Reason.MODERATOR_2_FLOOD;
    info.isSpam = 1;
  } else if (modNotSpamCount >= 2) {
    info.reason = Reason.MODERATOR_2_NOT_SPAM;
    info.isSpam = 0;
  } else if (modFloodCount === 1 && modNotSpamCount === 0) {
    info.reason = Reason.MODERATOR_1_FLOOD;
    info.isSpam = 1;
  } else if (modNotSpamCount === 1 && modFloodCount === 0) {
    info.reason = Reason.MODERATOR_1_NOT_SPAM;
    info.isSpam = 0;
  }

  return info;
}

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
        const mediaHash = await getMediaHash(message.media, message.replyMarkup);
        currentReport.mediaHashes.push(mediaHash);
      } catch (error) {
        logErr('handleCheck - getting media hash', error);
      }
    } else if (message.replyMarkup) {
      try {
        const buttonHash = await getMediaHash({} as Api.TypeMessageMedia, message.replyMarkup);
        if (buttonHash.startsWith('url_button:')) {
          currentReport.mediaHashes.push(buttonHash);
        }
      } catch (error) {
        logErr('handleCheck - checking URL buttons', error);
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

    if (sysInfo.reportId) {
      await saveReportIdToRedis(sysInfo.reportId);
      await redis.hmset(`moderator_opinion:${sysInfo.reportId}`, {
        modFlood: sysInfo.reason === Reason.MODERATOR_1_FLOOD || sysInfo.reason === Reason.MODERATOR_2_FLOOD ? 1 : 0,
        modNotSpam: sysInfo.reason === Reason.MODERATOR_1_NOT_SPAM || sysInfo.reason === Reason.MODERATOR_2_NOT_SPAM ? 1 : 0
      });

      if (!currentReport.reportId || currentReport.reportId === sysInfo.reportId) {
        currentReport = { ...currentReport, ...sysInfo };
        DEEP_LOG && log(`Updated current report: ${JSON.stringify(currentReport, null, 2)}`);
      } else {
        currentReport = { ...sysInfo };
        DEEP_LOG && log(`New report received: ${JSON.stringify(currentReport, null, 2)}`);
      }

      if (!currentReport.messageContent || currentReport.messageContent.length === 0) {
        const validationResult = validateReport(currentReport as Report);
        if (validationResult.isValid) {
          if (autoMode) {
            const existingReportIndex = reportQueue.findIndex(report => report.reportId === sysInfo.reportId);
            if (existingReportIndex !== -1) {
              reportQueue[existingReportIndex] = { ...reportQueue[existingReportIndex], ...currentReport };
            } else {
              reportQueue.push(currentReport as Report);
            }
            DEEP_LOG && log('Current report without message added or updated in queue');
            processNextReport();
          } else {
            await saveToCache(currentReport as Report);
            DEEP_LOG && log('Current report without message saved to cache (auto mode off)');
          }
        } else {
          log(`Report validation failed: ${validationResult.error}`);
          DEEP_LOG && log(`Invalid report data: ${JSON.stringify(currentReport, null, 2)}`);
        }
      }
    } else {
      log('Warning: reportId is missing in the current report');
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

    await redis.set('last_add_msg', message.message, 'EX', 10);

    const addMsgRegex = /Report #r(\d+) marked as (spam|not spam) (😡|😌)/;
    const match = message.message.match(addMsgRegex);

    if (match) {
      const [, reportId, decision, emoji] = match;
      await handleReportCompletion(reportId, decision, emoji);
    } else {
      switch (message.message) {
        case "No Reports Found":
        case "Nothing to undo":
          break;
        case "Hello there! Send /next to start processing reports.":
          if (autoMode) {
            await sendToBot("/next");
          }
          break;
        case "Please select 😡 BAN or 😌 NO.":
        case "Sorry, an error has occurred during your request. Please try again later.":
          await handleUndoProcess(currentReport.reportId!);
          break;
        default:
          if (message.message.startsWith("Your Fee for this month:")) {
            DEEP_LOG && log(`Earnings info received: ${message.message}`);
            await notify(`Earnings update: ${message.message}`);
          }
      }
    }
  }
}

async function handleReportCompletion(reportId: string, decision: string, emoji: string) {
  log(`Report #${reportId} completed. Decision: ${decision} ${emoji}`);
  
  const finalDecision = `${decision} ${emoji}`;
  
  const cachedReport = await redis.get(`report:${reportId}`);
  if (cachedReport) {
    const report = JSON.parse(cachedReport) as Report;
    
    if (report.isSpam !== (decision === 'spam' ? 1 : 0)) {
      const mismatchMessage = `Mismatch detected for report #${reportId}. Our classification: ${report.isSpam ? 'spam' : 'not spam'}, Bot decision: ${decision}`;
      DEEP_LOG && log(mismatchMessage);
      await notify(mismatchMessage);
    }
    
    report.isSpam = decision === 'spam' ? 1 : 0;
    await saveReport(report);
  } else {
    DEEP_LOG && log(`No cached report found for #${reportId}`);
  }
  
  currentReport = {};
  reportQueue.length = 0;
  currentState = ReportProcessingState.WAITING_FOR_NEXT_REPORT;
  
  if (autoMode) {
    await delay(COMMAND_DELAY);
    await sendToBot("/next");
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

    switch (true) {
      case command === '/start':
        await startAutoMode();
        await notify('Automatic mode started');
        break;
      case command === '/stop':
        stopAutoMode();
        currentReport = {};
        currentState = ReportProcessingState.IDLE;
        await notify('Automatic mode stopped');
        break;
      case command === '/db':
        await handleDbExport();
        break;
      case command === '/status':
        await sendStatus();
        break;
      case command === '/reset':
        await resetRedisCache();
        break;
      case command.startsWith('/time '):
        const time = parseInt(command.split(' ')[1], 10);
        if (!isNaN(time) && time > 0) {
          PROCESSING_INTERVAL = time;
          await notify(`Processing interval set to ${time} ms`);
        } else {
          await notify('Invalid time value. Please enter a positive number.');
        }
        break;
      case command.startsWith('/delay '):
        const delay = parseInt(command.split(' ')[1], 10);
        if (!isNaN(delay) && delay > 0) {
          COMMAND_DELAY = delay;
          await notify(`Command delay set to ${delay} ms`);
        } else {
          await notify('Invalid delay value. Please enter a positive number.');
        }
        break;
      case command.startsWith('/toggle '):
        const toggles = command.split(' ').slice(1);
        for (const toggle of toggles) {
          switch (toggle) {
            case 'obvs':
              checkConfig.obviousSpam = !checkConfig.obviousSpam;
              break;
            case 'cache':
              checkConfig.cache = !checkConfig.cache;
              break;
            case 'gpt':
              checkConfig.gpt = !checkConfig.gpt;
              break;
            case 'mods':
              checkConfig.moderators = !checkConfig.moderators;
              break;
            default:
              await notify(`Unknown toggle: ${toggle}`);
          }
        }
        await notify(`Check configuration updated:\n${JSON.stringify(checkConfig, null, 2)}`);
        break;
      case /^\/correct\s+#r\d+$/.test(command):
        await handleCorrectDecision(command.split(' ')[1]);
        break;
      default:
        DEEP_LOG && log(`Unrecognized admin command: ${command}`);
        await notify(`Unrecognized command: ${command}`);
    }
  }
}

async function resetRedisCache(): Promise<void> {
  try {
    DEEP_LOG && log('Attempting to clear Redis cache...');
    await redis.flushdb();
    DEEP_LOG && log('Redis cache cleared successfully');
    await notify('Redis cache has been cleared successfully');
  } catch (error) {
    logErr('resetRedisCache', error);
    await notify(`Error clearing Redis cache: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleCorrectDecision(reportId: string) {
  try {
    const cachedReport = await redis.get(`report:${reportId}`);
    if (!cachedReport) {
      await notify(`Report ${reportId} not found in cache.`);
      return;
    }

    const report = JSON.parse(cachedReport) as Report;

    report.isSpam = report.isSpam === 1 ? 0 : 1;
    report.corrected = true;

    await saveToCache(report);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await saveToPostgresWithTransaction(report, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await notify(`Decision for ${reportId} has been corrected. New decision: ${report.isSpam ? 'SPAM' : 'NOT SPAM'}`);
  } catch (error) {
    logErr('handleCorrectDecision', error);
    await notify(`Error correcting decision for ${reportId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

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
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL,
        report_id TEXT,
        message_content TEXT[],
        media_hashes TEXT[],
        complaint_count INTEGER NOT NULL,
        source TEXT NOT NULL,
        sender TEXT NOT NULL,
        is_spam INTEGER,
        reason INTEGER,
        corrected BOOLEAN DEFAULT FALSE,
        confidence FLOAT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, created_at)
      ) PARTITION BY RANGE (created_at);
    `);
    
    const currentYear = new Date().getFullYear();
    const nextYear = currentYear + 1;
    
    for (let year of [currentYear, nextYear]) {
      for (let month = 1; month <= 12; month++) {
        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 1);
        
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];
        
        await client.query(`
          CREATE TABLE IF NOT EXISTS reports_y${year}m${month.toString().padStart(2, '0')}
          PARTITION OF reports
          FOR VALUES FROM ('${startDateStr}') TO ('${endDateStr}');
        `);
      }
    }
    
    const indexCheckQuery = `
      SELECT indexname FROM pg_indexes 
      WHERE schemaname = 'public' AND tablename = 'reports' 
      AND (indexname = 'idx_reports_is_spam_created_at' OR indexname = 'idx_reports_report_id');
    `;
    const indexCheckResult = await client.query(indexCheckQuery);
    const existingIndexes = indexCheckResult.rows.map(row => row.indexname);

    if (!existingIndexes.includes('idx_reports_is_spam_created_at')) {
      await client.query(`
        CREATE INDEX idx_reports_is_spam_created_at ON reports (is_spam, created_at);
      `);
    }
    if (!existingIndexes.includes('idx_reports_report_id')) {
      await client.query(`
        CREATE INDEX idx_reports_report_id ON reports (report_id);
      `);
    }

    const constraintCheckQuery = `
      SELECT constraint_name 
      FROM information_schema.table_constraints 
      WHERE table_name = 'reports' AND constraint_name = 'unique_report_id_created_at';
    `;
    const constraintCheckResult = await client.query(constraintCheckQuery);
    
    if (constraintCheckResult.rows.length === 0) {
      await client.query(`
        ALTER TABLE reports ADD CONSTRAINT unique_report_id_created_at UNIQUE (report_id, created_at);
      `);
    }
    
    await client.query('COMMIT');
    DEEP_LOG && log('Database initialized successfully with partitioning, indexes, and unique constraint');
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
    { handler: handleAddMsg, options: { fromUsers: [botUserId], incoming: true, pattern: /^(?!.*😱\d+).*$/ } },
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

async function gracefulShutdown(restart = false) {
  log('Starting graceful shutdown...');

  stopAutoMode();

  try {
    await pool.end();
    log('Database connection closed');
  } catch (error) {
    logErr('gracefulShutdown - closing database connection', error);
  }

  try {
    if (client) {
      await client.disconnect();
      log('Telegram client disconnected');
    }
  } catch (error) {
    logErr('gracefulShutdown - disconnecting Telegram client', error);
  }

  try {
    await redis.quit();
    log('Redis connection closed');
  } catch (error) {
    logErr('gracefulShutdown - closing Redis connection', error);
  }

  log('Graceful shutdown completed');
  
  if (restart) {
    log('Restarting application...');
    process.exit(1); // Exit with a non-zero code to trigger a restart
  } else {
    process.exit(0);
  }
}

async function main() {
  try {
    DEEP_LOG && log('Starting application...');

    try {
      await initDB();
      DEEP_LOG && log('Database initialized');
    } catch (dbError) {
      logErr('main - Database initialization', dbError);
    }

    const isConnected = await checkDB();
    if (!isConnected) throw new Error('Failed to connect to the database');
    DEEP_LOG && log('Database connection confirmed');

    const dbSettings = await checkDBSettings();
    if (dbSettings) {
      DEEP_LOG && log('Database settings checked successfully');
    } else {
      logErr('main', 'Failed to check database settings');
    }

    await checkDatabaseIndexes();
    log('Database indexes checked and created if necessary');

    try {
      await redis.ping();
      DEEP_LOG && log('Successfully connected to Redis');
    } catch (error) {
      logErr('main - Redis connection', error);
      throw new Error('Failed to connect to Redis');
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

    await updateSpamPhrases();
    log('Initial spam phrases update completed');

    app.listen(PORT, () => log(`Server running on port ${PORT}`));

    setInterval(checkInvalidReports, 6 * 60 * 60 * 1000);
    setInterval(checkAndManageMemory, 5 * 60 * 1000);
    setInterval(cleanupOldData, 60 * 60 * 1000);

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

      await checkRedisAndRestore();
    }, HEALTH_CHECK_INTERVAL);

    setInterval(async () => {
      if (!client || !client.connected) {
        DEEP_LOG && log('Lost connection to Telegram. Attempting to reconnect...');
        await reconnectClient();
      }
    }, 60000);

    setInterval(async () => {
      if (postgresQueue.length > 0) {
        await processPostgresQueue();
      }
    }, 60000);

    setInterval(async () => {
      const currentTime = Date.now();
      if (currentTime - lastProcessingTime > IDLE_TIMEOUT) {
        log('Application has been idle for too long. Performing undo and restarting...');
        await handleUndoProcess(currentReport.reportId || '');
        await gracefulShutdown(true);
      }
    }, IDLE_TIMEOUT);

    client.addEventHandler(async () => {
      if (!client.connected) {
        DEEP_LOG && log('Lost connection to Telegram. Attempting to reconnect...');
        await reconnectClient();
      }
    }, new NewMessage({}));

    process.on('unhandledRejection', (reason, promise) => {
      logErr('UnhandledRejection', `Reason: ${reason}`);
    });

    process.on('uncaughtException', (error) => {
      logErr('UncaughtException', error);
    });

    process.on('SIGINT', async () => {
      log('Received SIGINT. Shutting down gracefully');
      await gracefulShutdown();
    });

    process.on('SIGTERM', async () => {
      log('Received SIGTERM. Shutting down gracefully');
      await gracefulShutdown();
    });

    await notify('Application initialized successfully');

    if (autoMode) {
      await startAutoMode();
    }

  } catch (error) {
    logErr('main', error);
    await notify(`Application initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

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

main().catch(error => {
  logErr('main function', error);
  process.exit(1);
});