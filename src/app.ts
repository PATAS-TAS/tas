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
import { Parser } from 'json2csv';
import winston from 'winston';

dotenv.config();

const DEEP_LOG = false;
const app = express();
const port = process.env.PORT || 3000;
const adminId = parseInt(process.env.ADMIN_ID!, 10);
const dbUrl = process.env.DATABASE_URL!;
const { Pool } = pkg;

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

let client: TelegramClient;
const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

let botEntity: Api.InputPeerUser | null = null;

interface Report {
  reportId: string;
  messageContent?: string[];
  mediaHashes?: string[];
  complaintCount: number;
  source: string;
  sender: string;
  spamProbability?: number;
  hasExternalLink?: boolean;
  hasInternalLink?: boolean;
  moderatorDecisions?: string[];
  manualClassification?: string;
}

let currentReport: Partial<Report> = {};

async function initClient(): Promise<TelegramClient> {
  const apiId = parseInt(process.env.API_ID!, 10);
  const apiHash = process.env.API_HASH!;
  const sessionString = process.env.SESSION_STRING!;

  if (!apiId || !apiHash || !sessionString) {
    throw new Error('API_ID, API_HASH, and SESSION_STRING must be set in .env file');
  }
  DEEP_LOG && log('Initializing Telegram client...');
  const stringSession = new StringSession(sessionString);
  const client = new TelegramClient(stringSession, apiId, apiHash, {
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
        moderator_decisions TEXT[],
        manual_classification TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`
      ALTER TABLE reports
      ALTER COLUMN spam_probability DROP NOT NULL;
    `);
    DEEP_LOG && log('Database initialized successfully');
  } catch (error) {
    logErr('initDB', error);
    throw error;
  } finally {
    client.release();
  }
}

async function initBot() {
  const botId = process.env.BOT_ID;
  const botAccessHash = process.env.BOT_ACCESS_HASH;

  if (!botId || !botAccessHash) {
    throw new Error('BOT_ID and BOT_ACCESS_HASH must be set in .env file');
  }

  try {
    DEEP_LOG && log(`BOT_ID: ${botId}, BOT_ACCESS_HASH: ${botAccessHash}`);
    botEntity = new Api.InputPeerUser({
      userId: bigInt(botId),
      accessHash: bigInt(botAccessHash)
    });
    DEEP_LOG && log('Bot entity initialized successfully');
  } catch (error) {
    logErr('initBot', error);
    throw error;
  }
}

async function handleCheck(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && event.isPrivate && botEntity && message.senderId?.toString() === botEntity.userId.toString()) {
    log(`Received message for check: ${message.message}`);
    
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
        if (repliedMessage?.message) processedMessage += ` [Quoted: ${repliedMessage.message}]`;
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

function preprocessMessage(message: string): string {
  return message.split('\n').slice(1).join('\n');
}

async function handleSys(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && event.isPrivate && botEntity && message.senderId?.toString() === botEntity.userId.toString()) {
    DEEP_LOG && log(`Received system message: ${message.message}`);
    const sysInfo = parseSysMsg(message.message || '');
    DEEP_LOG && log(`Parsed system info: ${JSON.stringify(sysInfo, null, 2)}`);
    
    DEEP_LOG && log(`Current report before merging: ${JSON.stringify(currentReport, null, 2)}`);
    
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

function parseSysMsg(msg: string): Partial<Report> {
  const info: Partial<Report> = {};
  const lines = msg.split('\n');
  
  for (const line of lines) {
    if (line.includes('#r')) {
      const reportIdMatch = line.match(/#r(\d+)/);
      if (reportIdMatch) {
        info.reportId = reportIdMatch[1];
      }
      const complaintMatch = line.match(/😱(\d+)/);
      if (complaintMatch) {
        info.complaintCount = parseInt(complaintMatch[1]);
      }
      if (line.includes('🔴')) info.hasExternalLink = true;
      if (line.includes('🔶')) info.hasInternalLink = true;
    }
    if (line.startsWith('Source:') || line.startsWith('🗣 Source:'))
      info.source = line.replace(/^🗣?\s*Source:\s*/, '').trim();
    if (line.startsWith('Sender:'))
      info.sender = line.replace('Sender:', '').trim();
    const spamProbMatch = line.match(/(?:🌕|🌔|🌓|🌒|🌚)\s*(\d+)%/);
    if (spamProbMatch) info.spamProbability = parseInt(spamProbMatch[1]);
    if (line.includes('– Flood') || line.includes('– Not Spam')) {
      if (!info.moderatorDecisions) info.moderatorDecisions = [];
      info.moderatorDecisions.push(line.trim());
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

interface ValidationResult {
  isValid: boolean;
  error?: string;
}

function validateReport(report: Partial<Report>): ValidationResult {
  if (!report.reportId || typeof report.reportId !== 'string') {
    return { isValid: false, error: `Invalid or missing reportId: ${JSON.stringify(report.reportId)}` };
  }
  if (report.complaintCount === undefined || typeof report.complaintCount !== 'number') {
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
  return { isValid: true };
}

function isValidReport(report: Partial<Report>): boolean {
  return validateReport(report).isValid;
}

async function saveReport(report: Report) {
  const validationResult = validateReport(report);
  if (!validationResult.isValid) {
    logErr('saveReport', validationResult.error || 'Report validation failed');
    return;
  }
  
  log(`Saving report: ${report.reportId}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const query = `
      INSERT INTO reports (
        report_id, message_content, media_hashes, complaint_count, source, sender,
        spam_probability, has_external_link, has_internal_link,
        moderator_decisions, manual_classification
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
        moderator_decisions = COALESCE(EXCLUDED.moderator_decisions, reports.moderator_decisions),
        manual_classification = COALESCE(EXCLUDED.manual_classification, reports.manual_classification)
    `;
    const values = [
      report.reportId,
      report.messageContent || null,
      report.mediaHashes || null,
      report.complaintCount,
      report.source,
      report.sender,
      report.spamProbability !== undefined ? report.spamProbability : null,
      report.hasExternalLink || null,
      report.hasInternalLink || null,
      report.moderatorDecisions || null,
      report.manualClassification || null
    ];
    await client.query(query, values);
    await client.query('COMMIT');
    log(`Report saved: ${report.reportId}`);
  } catch (error) {
    await client.query('ROLLBACK');
    logErr('saveReport', error);
  } finally {
    client.release();
  }
}

async function notify(msg: string) {
  try {
    await client.sendMessage(adminId, { message: msg });
    DEEP_LOG && log(`Admin notified: ${msg}`);
  } catch (error) {
    logErr('notify', error);
  }
}

async function handleAdmin(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && message.senderId?.toString() === adminId.toString()) {
    if (message.message === '/db') {
      DEEP_LOG && log('Admin requested database export');
      try {
        const filename = await exportCSV();
        const fileStats = fs.statSync(filename);
        await client.sendFile(adminId, {
          file: filename,
          caption: `Database export: ${filename}\nSize: ${fileStats.size} bytes`,
        });
        fs.unlinkSync(filename);
        DEEP_LOG && log('Database export sent to admin');
      } catch (error) {
        logErr('handleAdmin - database export', error);
      }
    }
  }
}

async function setupHandlers() {
  if (!botEntity) throw new Error('Bot entity not initialized');
  const botUserId = botEntity.userId.toJSNumber();
  client.addEventHandler(handleCheck, new NewMessage({ fromUsers: [botUserId], incoming: true, forwards: true }));
  client.addEventHandler(handleSys, new NewMessage({ fromUsers: [botUserId], incoming: true, pattern: /😱\d+/ }));
  client.addEventHandler(handleManual, new NewMessage({ outgoing: true, chats: [botUserId] }));
  client.addEventHandler(handleAdmin, new NewMessage({ fromUsers: [adminId], incoming: true }));
  DEEP_LOG && log('Event handlers set up successfully');
}

async function exportCSV(): Promise<string> {
  const client = await pool.connect();
  try {
    DEEP_LOG && log('Executing database query for export...');
    const result = await client.query('SELECT * FROM reports');
    DEEP_LOG && log(`Query executed. Found ${result.rows.length} rows.`);

    const fields = [
      'id', 'report_id', 'message_content', 'media_hashes', 'complaint_count',
      'source', 'sender', 'spam_probability', 'has_external_link',
      'has_internal_link', 'moderator_decisions', 'manual_classification',
      'created_at'
    ];
    const parser = new Parser({ fields });
    
    let csv = result.rows.length > 0 ? parser.parse(result.rows) : 'No data found in the database.';
    DEEP_LOG && log(result.rows.length > 0 ? 'Data parsed to CSV format' : 'No data found in the database');

    const filename = `reports_export_${Date.now()}.csv`;
    fs.writeFileSync(filename, csv);
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

async function main() {
  try {
    await initDB();
    const isConnected = await checkDB();
    if (!isConnected) throw new Error('Failed to connect to the database');

    const dbSettings = await checkDBSettings();
    if (dbSettings) {
      DEEP_LOG && log('Database settings checked successfully');
    } else {
      logErr('main', 'Failed to check database settings');
    }

    client = await initClient();
    await initBot();
    await setupHandlers();
    log('Telegram client initialized successfully');

    app.listen(port, () => log(`Server running on port ${port}`));

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

    setInterval(async () => {
      const isStillConnected = await checkDB();
      if (!isStillConnected) {
        logErr('main', 'Lost connection to the database. Attempting to reconnect...');
        await initDB();
      }
    }, 60000);

    setInterval(async () => {
      DEEP_LOG && log('Performing periodic health check...');
      await checkDB();
      const reportCount = await checkDBContent();
      DEEP_LOG && log(`Current number of reports in database: ${reportCount}`);
    }, 300000);

    await notify('Application initialized successfully');

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

main().catch(error => {
  logErr('main function', error);
  process.exit(1);
});