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
import OpenAI from 'openai';
import Redis from 'ioredis';
import { LRUCache } from 'lru-cache';
import { tmpdir } from 'os';
import { join } from 'path';
import pkg from 'pg';

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
let COMMAND_DELAY = 1000;
const MAX_CACHE_SIZE = 10000;
const DB_SCHEMA_VERSION = '1.0';
const MEDIA_EXPIRY = 600; // 10 minutes
const ENABLE_GPT_MEDIA_ANALYSIS = true;

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

// Global variables
let client: TelegramClient;
let botEntity: Api.InputPeerUser | null = null;
let autoMode = true;
let totalProcessedReports = 0;
let totalProcessingTime = 0;
let isProcessingReport = false;
let currentOpenReport: string | null = null;

// Interfaces and types
interface Report {
  reportId: string;
  messageContent: string[];
  mediaHashes: string[];
  complaintCount: number;
  source: string;
  sender: string;
  isSpam: number;
  reason?: string;
  confidence?: number;
  timestamp: number;
  adminSender?: string;
  isOpen: boolean;
  decisionSent: boolean; // Новое поле
}

type SpamDecision = {
  isSpam: number;
  reason: string;
  confidence: number;
  checkType: 'fast' | 'moderator' | 'gpt';
};

// Regular expressions
const sysRegex = {
  reportId: /#r(\d+)/,
  complaintCount: /😱(\d+)/,
  source: /^(?:🗣\s*)?Source:\s*(.+)/m,
  sender: /^Sender:\s*(.+)/m,
  admin: /^Admin:\s*(.+)/m,
  modFlood: /– Flood/,
  modNotSpam: /– Not Spam/
};

// LRU Cache initialization
const moderatorOpinionsCache = new LRUCache<string, string>({
  max: 1000,
  ttl: 1000 * 60, // 1 minute
});

// Utility functions
const log = (message: string, level: 'info' | 'debug' | 'error' = 'info') => {
  switch (level) {
    case 'debug':
      logger.debug(message);
      break;
    case 'error':
      logger.error(message);
      break;
    default:
      logger.info(message);
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('Operation timed out')), timeoutMs);
  });
  
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle!);
  }
}

// Database functions
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL,
        report_id TEXT UNIQUE NOT NULL,
        message_content TEXT[],
        media_hashes TEXT[],
        complaint_count INTEGER NOT NULL,
        source TEXT NOT NULL,
        sender TEXT NOT NULL,
        is_spam INTEGER,
        reason TEXT,
        confidence FLOAT,
        admin_sender TEXT,
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

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    logErr('initDB', error);
    throw error;
  } finally {
    client.release();
  }
}

async function checkDBVersion() {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT version FROM schema_version ORDER BY id DESC LIMIT 1');
    const currentVersion = result.rows[0]?.version;
    if (currentVersion !== DB_SCHEMA_VERSION) {
      throw new Error(`Database schema version mismatch. Expected ${DB_SCHEMA_VERSION}, got ${currentVersion}`);
    }
    log(`Database schema version check passed: ${currentVersion}`, 'info');
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

      for (const key of keys) {
        const reportData = await redis.get(key);
        if (reportData) {
          const report = JSON.parse(reportData) as Report;
          const query = `
            INSERT INTO reports (report_id, message_content, media_hashes, complaint_count, source, sender, is_spam, reason, confidence, admin_sender, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (report_id) DO UPDATE SET
            message_content = EXCLUDED.message_content,
            media_hashes = EXCLUDED.media_hashes,
            complaint_count = EXCLUDED.complaint_count,
            source = EXCLUDED.source,
            sender = EXCLUDED.sender,
            is_spam = EXCLUDED.is_spam,
            reason = EXCLUDED.reason,
            confidence = EXCLUDED.confidence,
            admin_sender = EXCLUDED.admin_sender;
          `;
          await client.query(query, [
            report.reportId,
            report.messageContent,
            report.mediaHashes,
            report.complaintCount,
            report.source,
            report.sender,
            report.isSpam,
            report.reason,
            report.confidence,
            report.adminSender,
            new Date(report.timestamp)
          ]);
        }
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

// Telegram client functions
async function initClient(): Promise<TelegramClient> {
  if (!API_ID || !API_HASH || !SESSION_STRING) {
    throw new Error('API_ID, API_HASH, and SESSION_STRING must be set in .env file');
  }

  log('Initializing Telegram client...', 'info');
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
    log('Client connected and authorized successfully', 'info');
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

async function checkBotConnection() {
  if (!botEntity) throw new Error('Bot entity not initialized');
  try {
    const botInfo = await client.getEntity(botEntity);
    if ('firstName' in botInfo) {
      log(`Successfully connected to bot: ${botInfo.firstName}`, 'info');
    } else {
      log(`Successfully connected to bot`, 'info');
    }
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to connect to bot: ${error.message}`);
    } else {
      throw new Error('Failed to connect to bot: Unknown error');
    }
  }
}

async function sendToBot(message: string) {
  if (!botEntity) throw new Error('Bot entity not initialized');
  await retry(async () => {
    await withTimeout(
      new Promise<void>((resolve) => {
        setTimeout(() => {
          client.sendMessage(botEntity!, { message });
          log(`Message sent to bot: ${message}`, 'debug');
          resolve();
        }, COMMAND_DELAY);
      }),
      10000 // 10 seconds timeout
    );
  });
}

async function reconnect() {
  try {
    log('Attempting to reconnect Telegram client...', 'info');
    if (client) {
      await client.disconnect();
    }
    client = await initClient();
    await setupHandlers();
    log('Telegram client reconnected successfully', 'info');
  } catch (error) {
    logErr('reconnect', error);
    throw new Error('Failed to reconnect Telegram client');
  }
}

// Report processing functions
function openNew(): void {
  const tempId = `temp_${Date.now()}`;
  const newReport: Report = {
    reportId: tempId,
    messageContent: [],
    mediaHashes: [],
    complaintCount: 0,
    source: '',
    sender: '',
    isSpam: -1,
    timestamp: Date.now(),
    isOpen: true,
    decisionSent: false // Добавляем новое поле
  };
  currentOpenReport = tempId;
  saveCache(newReport);
  log(`New report opened with temp ID: ${tempId}`, 'debug');
}

async function processReport(report: Report): Promise<void> {
  if (isProcessingReport) {
    log(`Another report is already being processed. Cannot process ${report.reportId}`, 'debug');
    return;
  }

  isProcessingReport = true;
  const startTime = Date.now();

  try {
    log(`Starting to process report ${report.reportId}`, 'debug');
    let decision: SpamDecision | null = null;

    // Fast check
    decision = await fastCheck(report);

    // If no decision from fast check, proceed with moderator check
    if (!decision) {
      const modResult = await modCheck(report);
      if (modResult.decision) {
        decision = modResult.decision;
      } else if (modResult.newSysMsg) {
        // If no clear decision from moderators but we got a new sysMsg, proceed with GPT check
        decision = await gptCheck(report);
      }
    }

    if (decision) {
      await applyDecision(report, decision);
    } else {
      log(`No decision made for ${report.reportId}, skipping to next report`, 'debug');
      await sendToBot("/next 9");
    }

    // Open a new report for the next message
    openNew();

    // Close the current report
    await closeReport(report.reportId);

  } catch (error) {
    logErr('processReport', error);
    await notify(`Error processing report ${report.reportId}: ${error instanceof Error ? error.message : String(error)}`);
    await undo(report.reportId);
  } finally {
    const processingTime = Date.now() - startTime;
    updateMetrics(processingTime);
    
    isProcessingReport = false;
    log(`Finished processing report ${report.reportId}`, 'debug');
  }
}

async function fastCheck(report: Report): Promise<SpamDecision | null> {
  const cachedDecision = await checkCache(report.reportId);
  if (cachedDecision) return cachedDecision;

  const hasLinksOrContacts = report.messageContent.some(msg => 
    msg.includes('http') || msg.includes('@') || /\+?\d{10,}/.test(msg)
  );
  const hasMedia = report.mediaHashes.length > 0;
  
  if ((hasLinksOrContacts || hasMedia) && report.complaintCount > 2) {
    return { isSpam: 1, reason: "Fast check: Links/contacts/media with >2 complaints", confidence: 90, checkType: 'fast' };
  }

  const hasInlineKeyboard = report.mediaHashes.some(hash => hash.startsWith('inline_keyboard:'));
  const hasStory = report.mediaHashes.some(hash => hash.startsWith('story:'));
  const hasQuoteReply = report.messageContent.some(msg => msg.includes('Replied to:'));

  if (hasInlineKeyboard || hasStory || hasQuoteReply) {
    return { isSpam: 1, reason: "Fast check: Inline keyboard/story/quote reply", confidence: 85, checkType: 'fast' };
  }

  return null;
}

async function modCheck(report: Report): Promise<{ decision: SpamDecision | null, newSysMsg: boolean }> {
  const MAX_ATTEMPTS = 5; // Максимальное количество попыток
  let attempts = 0;

  try {
    if (!report.adminSender) {
      await sendToBot("/stats");
      const statsReceived = await waitStats();
      if (!statsReceived) {
        log(`Timeout waiting for stats message for report ${report.reportId}`, 'error');
        return { decision: null, newSysMsg: false };
      }

      await sendToBot(report.reportId);
      const updatedAdminSender = await waitUpdated(report.reportId);
      if (!updatedAdminSender) {
        log(`No updated report received for ${report.reportId} after waiting`, 'error');
        return { decision: null, newSysMsg: false };
      }

      report.adminSender = updatedAdminSender;
      await saveCache(report);
    }

    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      
      // Send "/next 2" command
      await sendToBot("/next 2");
      const receivedCorrectSysMsg = await waitForSysMsg(report.reportId);
      if (!receivedCorrectSysMsg) {
        log(`Did not receive correct sysMsg for ${report.reportId} after attempt ${attempts}`, 'error');
        continue; // Try again
      }

      // Process moderator decision only after receiving the correct sysMsg without "Admin:"
      const lastSysMsg = await redis.get('last_sys_msg');
      if (lastSysMsg && !lastSysMsg.includes('Admin:')) {
        const decision = report.adminSender ? processMod(report.adminSender) : null;
        return { decision, newSysMsg: true };
      } else {
        log(`Received sysMsg with Admin for ${report.reportId}, attempt ${attempts}`, 'debug');
      }
    }

    // If we've reached this point, we've exceeded the maximum number of attempts
    log(`Exceeded maximum attempts (${MAX_ATTEMPTS}) for report ${report.reportId}`, 'error');
    return { decision: null, newSysMsg: false };
  } catch (error) {
    logErr('modCheck', error);
    return { decision: null, newSysMsg: false };
  }
}

function processMod(sysMsg: string): SpamDecision | null {
  const floodCount = (sysMsg.match(/– Flood/g) || []).length;
  const notSpamCount = (sysMsg.match(/– Not Spam/g) || []).length;

  if (floodCount === 0 && notSpamCount === 0) {
    log(`Admin message without clear spam indication: ${sysMsg}`, 'debug');
    return null;
  }

  if (floodCount >= 2) {
    return { isSpam: 1, reason: "Moderators: Multiple Flood", confidence: 100, checkType: 'moderator' };
  } else if (notSpamCount >= 2) {
    return { isSpam: 0, reason: "Moderators: Multiple Not Spam", confidence: 100, checkType: 'moderator' };
  } else if (floodCount === 1 && notSpamCount === 0) {
    return { isSpam: 1, reason: "Moderators: Single Flood", confidence: 90, checkType: 'moderator' };
  } else if (notSpamCount === 1 && floodCount === 0) {
    return { isSpam: 0, reason: "Moderators: Single Not Spam", confidence: 90, checkType: 'moderator' };
  }

  log(`Ambiguous moderator opinions: ${floodCount} Flood, ${notSpamCount} Not Spam`, 'debug');
  return null;
}

async function gptCheck(report: Report): Promise<SpamDecision | null> {
  const gptPrompt = `As an AI trained in commercial spam detection for Telegram groups, analyze the provided information (including any images) for potential spam. Consider all aspects, including content, context, metadata, and visual elements. Be cautious and conservative in your assessment to minimize false positives.

Guidelines for spam classification:
1. Look for clear indicators of commercial spam such as unsolicited advertising, promotional content, or affiliate marketing.
2. Consider the relevance of the message and images to the group's topic or recent conversations.
3. Evaluate the use of excessive formatting, caps, repetitive patterns, or suspicious visual elements that may indicate spam.
4. Assess the presence of suspicious links, especially shortened URLs or links to unfamiliar domains.
5. Check for signs of automation or bulk messaging that could indicate spam campaigns.
6. Consider the complaint count, but don't rely solely on it for classification.
7. Be aware of potential false positives in cases of controversial but legitimate content.
8. For images, look for spam-related text, QR codes, or promotional imagery.
9. In cases with no message content, focus on available metadata and image analysis.

Classify the information as either spam (1) or not spam (0). Provide a confidence score from 0 to 100, where 100 is absolute certainty.

Output your response in the following format:
classification,confidence

Example outputs:
1,95
0,80
0,60

Your analysis:`;

  const mediaPrompt = `As an AI trained in commercial spam detection for Telegram groups, analyze the provided image for potential spam. Focus on visual elements that may indicate unsolicited advertising, promotional content, or affiliate marketing.

Guidelines for image spam classification:
1. Look for clear visual indicators of commercial spam such as promotional banners, product advertisements, or marketing materials.
2. Check for text overlays that promote products, services, or websites.
3. Assess the presence of QR codes or barcodes that may lead to promotional content.
4. Evaluate any logos or branding elements that seem out of context or overtly commercial.
5. Consider the overall composition and purpose of the image in the context of a Telegram group.

Classify the image as either spam (1) or not spam (0). Respond only with the classification number.

Your analysis:`;

  const userPrompt = generateUserPrompt(report);

  const textMessages: Array<ChatCompletionMessageParam> = [
    { role: "system", content: gptPrompt },
    { role: "user", content: userPrompt }
  ];

  const mediaMessages: Array<ChatCompletionMessageParam> = [
    { role: "system", content: mediaPrompt },
  ];

  try {
    let textDecision: SpamDecision | null = null;
    let mediaDecision: SpamDecision | null = null;

    // Process text content
    if (report.messageContent.length > 0) {
      const textResponse = await openai.chat.completions.create({
        model: "gpt-4-1106-preview",
        messages: textMessages,
        max_tokens: 10,
        temperature: 0.1,
      });

      const textContent = textResponse.choices[0]?.message?.content?.trim();
      if (textContent) {
        const [classification, confidence] = textContent.split(',');
        if (classification === '0' || classification === '1') {
          textDecision = {
            isSpam: Number(classification),
            reason: Number(classification) === 1 ? "GPT: spam" : "GPT: not spam",
            confidence: Number(confidence),
            checkType: 'gpt'
          };
        }
      }
    }
    // Process media content only if:
    // 1. ENABLE_GPT_MEDIA_ANALYSIS is true
    // 2. There's no text content
    // 3. There are media hashes to analyze
    else if (ENABLE_GPT_MEDIA_ANALYSIS && report.mediaHashes.length > 0) {
      for (const mediaHash of report.mediaHashes) {
        if (await isGPT4VisionCompatible(mediaHash)) {
          const mediaKey = `media:${mediaHash.split(':')[1]}`;
          const mediaBuffer = await getMediaFromRedis(mediaKey);
          if (mediaBuffer) {
            const base64Image = mediaBuffer.toString('base64');
            mediaMessages.push({
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
              ] as ChatCompletionContentPart[]
            });

            const mediaResponse = await openai.chat.completions.create({
              model: "gpt-4-vision-preview",
              messages: mediaMessages,
              max_tokens: 1,
              temperature: 0.1,
            });

            const mediaContent = mediaResponse.choices[0]?.message?.content?.trim();
            if (mediaContent) {
              mediaDecision = {
                isSpam: mediaContent === '1' ? 1 : 0,
                reason: `GPT media: ${mediaContent === '1' ? 'spam' : 'not spam'}`,
                confidence: 90,
                checkType: 'gpt'
              };
              if (mediaDecision.isSpam === 1) {
                break; // Exit loop if spam is detected in any media
              }
            }
          }
        }
      }
    }

    // Return the decision
    if (textDecision) {
      return textDecision;
    } else if (mediaDecision) {
      return mediaDecision;
    }

    return null;
  } catch (error) {
    logErr('gptCheck', error);
    return null;
  }
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
    prompt += "\nNote: No message content available.";
  }

  return prompt;
}

async function applyDecision(report: Report, decision: SpamDecision): Promise<void> {
  log(`Applying decision for ${report.reportId}: ${JSON.stringify(decision)}`, 'debug');
  
  await sendDecision(report, decision);
  
  const updatedReport: Report = {
    ...report,
    isSpam: decision.isSpam,
    reason: decision.reason,
    confidence: decision.confidence,
    isOpen: false,
    decisionSent: true
  };
  
  await saveCache(updatedReport);
  await addToRecentReportIds(report.reportId);
  log(`Decision applied and saved for report ${report.reportId}`, 'debug');
}

async function sendDecision(report: Report, decision: SpamDecision): Promise<void> {
  if (report.decisionSent) {
    log(`Decision already sent for report ${report.reportId}, skipping`, 'debug');
    return;
  }

  await sendToBot(decision.isSpam ? '😡 SPAM' : '😌 NO');
  log(`Sent decision: ${decision.isSpam ? 'SPAM' : 'NOT SPAM'}`, 'debug');
  report.decisionSent = true;
  await saveCache(report);
}

async function closeReport(reportId: string): Promise<void> {
  const report = await getFromCache(reportId);
  if (report) {
    report.isOpen = false;
    await saveCache(report);
    log(`Closed report ${reportId}`, 'debug');
  }
}

// Cache functions
async function saveCache(report: Report): Promise<void> {
  const cacheKey = `report:${report.reportId}`;
  await redis.set(cacheKey, JSON.stringify(report), 'EX', 86400); // Cache for 24 hours

  log(`Report ${report.reportId} saved to cache`, 'debug');
}

async function getFromCache(reportId: string): Promise<Report | null> {
  const cacheKey = `report:${reportId}`;
  const cachedReport = await redis.get(cacheKey);
  
  if (cachedReport) {
    return JSON.parse(cachedReport) as Report;
  }

  return null;
}

async function checkCache(reportId: string): Promise<SpamDecision | null> {
  const cachedReport = await getFromCache(reportId);
  
  if (cachedReport && cachedReport.isSpam !== -1) {
    return {
      isSpam: cachedReport.isSpam,
      reason: cachedReport.reason || "Cached decision",
      confidence: cachedReport.confidence || 100,
      checkType: 'fast'
    };
  }

  return null;
}

async function limitCacheSize() {
  const keysCount = await redis.dbsize();
  if (keysCount > MAX_CACHE_SIZE) {
    const keysToRemove = keysCount - MAX_CACHE_SIZE;
    const keys = await redis.keys('report:*');
    const oldestKeys = keys.sort().slice(0, keysToRemove);
    if (oldestKeys.length > 0) {
      await redis.del(...oldestKeys);
      log(`Removed ${oldestKeys.length} oldest keys from Redis cache`, 'info');
    }
  }
}

async function addToRecentReportIds(reportId: string): Promise<void> {
  await redis.lpush('recent_report_ids', reportId);
  await redis.ltrim('recent_report_ids', 0, 9); // Keep only the 10 most recent report IDs
}

async function getRecentReportIds(): Promise<string[]> {
  return redis.lrange('recent_report_ids', 0, 9);
}

// Media handling functions
async function isGPT4VisionCompatible(mediaHash: string): Promise<boolean> {
  const GPT4VisionCompatibleMedia = ['photo', 'sticker', 'gif', 'video', 'videonote'];
  const mediaType = mediaHash.split(':')[0];
  return GPT4VisionCompatibleMedia.includes(mediaType);
}

async function getHash(media: Api.TypeMessageMedia): Promise<string> {
  if (media instanceof Api.MessageMediaEmpty) return 'empty';
  if (media instanceof Api.MessageMediaPhoto && media.photo) return `photo:${media.photo.id}`;
  if (media instanceof Api.MessageMediaDocument && media.document) {
    if ('attributes' in media.document) {
      const attr = media.document.attributes.find((a: Api.TypeDocumentAttribute) => 
        a instanceof Api.DocumentAttributeSticker ||
        a instanceof Api.DocumentAttributeAnimated ||
        a instanceof Api.DocumentAttributeAudio ||
        a instanceof Api.DocumentAttributeVideo
      );
      if (attr instanceof Api.DocumentAttributeSticker) return `sticker:${media.document.id}`;
      if (attr instanceof Api.DocumentAttributeAnimated) return `gif:${media.document.id}`;
      if (attr instanceof Api.DocumentAttributeAudio) return `${attr.voice ? 'voice' : 'audio'}:${media.document.id}`;
      if (attr instanceof Api.DocumentAttributeVideo) return `${attr.roundMessage ? 'videonote' : 'video'}:${media.document.id}`;
    }
    return `file:${media.document.id}`;
  }
  if (media instanceof Api.MessageMediaWebPage && media.webpage) {
    if (media.webpage instanceof Api.WebPage) {
      return `webpage:${media.webpage.id}`;
    }
    return 'webpage:unknown';
  }
  if (media instanceof Api.MessageMediaPoll && media.poll) return `poll:${media.poll.id}`;
  if (media instanceof Api.MessageMediaGeo && media.geo) {
    if (media.geo instanceof Api.GeoPoint) {
      return `geo:${media.geo.long},${media.geo.lat}`;
    }
    return 'geo:unknown';
  }
  if (media instanceof Api.MessageMediaGeoLive && media.geo) {
    if (media.geo instanceof Api.GeoPoint) {
      return `geolive:${media.geo.long},${media.geo.lat}`;
    }
    return 'geolive:unknown';
  }
  if (media instanceof Api.MessageMediaContact) return `contact:${media.phoneNumber}`;
  if (media instanceof Api.MessageMediaGame && media.game) return `game:${media.game.id}`;
  if (media instanceof Api.MessageMediaInvoice) return `invoice:${media.title}`;
  if (media instanceof Api.MessageMediaDice) return `dice:${media.emoticon}:${media.value}`;
  if (media instanceof Api.MessageMediaStory) return `story:${media.id}`;
  if (media instanceof Api.MessageMediaVenue) return `venue:${media.title}`;
  if (media instanceof Api.MessageMediaUnsupported) return 'unsupported';

  return `unknown:${media.className}:${JSON.stringify(media)}`;
}

async function downloadAndStoreMedia(media: Api.TypeMessageMedia): Promise<string | null> {
  try {
    if (media instanceof Api.MessageMediaPhoto && media.photo) {
      const buffer = await client.downloadMedia(media);
      if (buffer) {
        const mediaKey = `media:${media.photo.id}`;
        await redis.set(mediaKey, buffer.toString('base64'), 'EX', MEDIA_EXPIRY);
        return mediaKey;
      }
    } else if (media instanceof Api.MessageMediaDocument && media.document) {
      const buffer = await client.downloadMedia(media);
      if (buffer) {
        const mediaKey = `media:${media.document.id}`;
        await redis.set(mediaKey, buffer.toString('base64'), 'EX', MEDIA_EXPIRY);
        return mediaKey;
      }
    }
  } catch (error) {
    logErr('downloadAndStoreMedia', error);
  }
  return null;
}

async function getMediaFromRedis(mediaKey: string): Promise<Buffer | null> {
  try {
    const mediaBase64 = await redis.get(mediaKey);
    if (mediaBase64) {
      return Buffer.from(mediaBase64, 'base64');
    }
  } catch (error) {
    logErr('getMediaFromRedis', error);
  }
  return null;
}

// Event handlers
async function handleCheck(event: NewMessageEvent) {
  if (!autoMode) {
    log('Automatic mode is off, skipping message check', 'debug');
    return;
  }

  const message = event.message;
  if (
    message instanceof Api.Message &&
    event.isPrivate &&
    botEntity &&
    message.senderId?.toString() === botEntity.userId.toString()
  ) {
    log(`Received message for check: ${message.message}`, 'debug');

    if (!currentOpenReport) {
      openNew();
    }

    const report = await getFromCache(currentOpenReport!);
    if (!report) {
      log(`No open report found for ${currentOpenReport}`, 'error');
      return;
    }

    const processedMessage = preprocess(message.message || '');
    report.messageContent.push(processedMessage);

    if (message.media) {
      try {
        const mediaHash = await getHash(message.media);
        report.mediaHashes.push(mediaHash);
        
        // Download and store media for potential GPT-4 Vision analysis
        await downloadAndStoreMedia(message.media);
      } catch (error) {
        logErr('handleCheck - getting media hash', error);
      }
    }

    await saveCache(report);
    log(`Updated current report: ${JSON.stringify(report)}`, 'debug');
  }
}

async function handleSys(event: NewMessageEvent) {
  const { message } = event;
  if (
    message instanceof Api.Message &&
    event.isPrivate &&
    botEntity &&
    message.senderId?.toString() === botEntity.userId.toString() &&
    (message.message?.includes('Sender:') || message.message?.includes('Admin:'))
  ) {
    log(`Received system message: ${message.message}`, 'debug');

    // Save the last system message in Redis
    await redis.set('last_sys_msg', message.message, 'EX', 30); // Store for 30 seconds

    const sysInfo = await parseSys(message.message || '');
    log(`Parsed system info: ${JSON.stringify(sysInfo)}`, 'debug');

    if (sysInfo.reportId) {
      const report = await getFromCache(currentOpenReport!);
      if (report && report.reportId === currentOpenReport) {
        // Update the report with the system info
        const updatedReport: Report = {
          ...report,
          ...sysInfo,
          reportId: sysInfo.reportId,
          isOpen: false
        };

        await saveCache(updatedReport);

        if (sysInfo.adminSender) {
          // This is a sysMsg with moderator opinions
          await handleModeratorOpinion(updatedReport);
        } else if (!isProcessingReport) {
          // This is the first sysMsg or a new report, and no report is currently being processed
          log(`Received initial sysMsg for report ${sysInfo.reportId}`, 'debug');
          // Close the current report
          await closeReport(currentOpenReport!);
          currentOpenReport = null;
          // Start processing the new report
          await processReport(updatedReport);
        } else {
          // If another report is already being processed, just log this
          log(`Received sysMsg for report ${sysInfo.reportId}, but another report is being processed.`, 'debug');
        }
      } else {
        log(`Received sysMsg for unknown report ${sysInfo.reportId}`, 'error');
      }
    } else {
      log('Warning: reportId is missing in the system message', 'error');
    }
  }
}

async function handleModeratorOpinion(report: Report) {
  log(`Handling moderator opinion for report ${report.reportId}`, 'debug');

  const sysMsg = await redis.get('last_sys_msg');
  if (!sysMsg) {
    log(`No system message found for report ${report.reportId}`, 'error');
    return;
  }

  // Save moderator opinion in the separate LRU cache
  moderatorOpinionsCache.set(report.reportId, sysMsg);

  const decision = processMod(sysMsg);
  if (decision) {
    log(`Moderator decision for ${report.reportId}: ${JSON.stringify(decision)}`, 'debug');
    
    // Apply the decision
    await applyDecision(report, decision);

    // Update the cache with the new decision
    await saveCache({
      ...report,
      isSpam: decision.isSpam,
      reason: decision.reason,
      confidence: decision.confidence,
      isOpen: false
    });
  } else {
    log(`No clear decision from moderators for report ${report.reportId}`, 'debug');
    if (!isProcessingReport) {
      // If there's no clear decision and no report is currently being processed,
      // start processing this report with GPT check
      await processReport(report);
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
    log(`Received additional message: ${message.message}`, 'debug');

    await redis.set('last_add_msg', message.message, 'EX', 10);

    if (message.message?.includes("No Reports Found")) {
      log('No reports found, applying undo', 'debug');
      await undo();
    } else if (message.message?.includes("Total this month:")) {
      // This is handled in waitStats function
    } else if (message.message?.includes("Hello there! Send /next to start processing reports.")) {
      if (autoMode) {
        await sendToBot("/next 6");
      }
    } else if (message.message?.includes("Please select 😡 BAN or 😌 NO.") ||
               message.message?.includes("Sorry, an error has occurred during your request. Please try again later.")) {
      await undo();
    }
  }
}

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
    const command = message.message.toLowerCase();

    switch (true) {
      case command === '/start':
        autoMode = true;
        await notify('Automatic mode started');
        await sendToBot("/next 7");
        break;
      case command === '/stop':
        autoMode = false;
        await notify('Automatic mode stopped');
        break;
      case command === '/status':
        await sendStatus();
        break;
      case command.startsWith('/time '):
        const newDelay = parseInt(command.split(' ')[1]);
        if (!isNaN(newDelay) && newDelay >= 0) {
          COMMAND_DELAY = newDelay;
          await notify(`Command delay updated to ${COMMAND_DELAY} ms`);
        } else {
          await notify('Invalid delay value. Please provide a non-negative integer.');
        }
        break;
      case command === '/reset':
        await resetRedisCache();
        break;
      case command === '/db':
        await handleDbCommand();
        break;
      default:
        log(`Unrecognized admin command: ${command}`, 'debug');
        await notify(`Unrecognized command: ${command}`);
    }
  }
}

// Helper functions for event handlers
async function waitStats(timeout: number = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const checkInterval = setInterval(async () => {
      const lastAddMsg = await redis.get('last_add_msg');
      if (lastAddMsg && lastAddMsg.includes("Total this month:")) {
        clearInterval(checkInterval);
        resolve(true);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(checkInterval);
        resolve(false);
      }
    }, 100);
  });
}

async function waitUpdated(reportId: string, timeout: number = 5000): Promise<string | null> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const report = await getFromCache(reportId);
    if (report && report.adminSender) {
      return report.adminSender;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

async function waitForSysMsg(expectedReportId: string, timeout: number = 10000): Promise<boolean> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const checkInterval = setInterval(async () => {
      const lastSysMsg = await redis.get('last_sys_msg');
      if (lastSysMsg) {
        const sysInfo = await parseSys(lastSysMsg);
        if (sysInfo.reportId === expectedReportId) {
          clearInterval(checkInterval);
          resolve(true);
        }
      }
      if (Date.now() - startTime > timeout) {
        clearInterval(checkInterval);
        resolve(false);
      }
    }, 100);
  });
}

function preprocess(message: string): string {
  return message.split('\n').slice(1).join('\n').trim();
}

async function parseSys(msg: string): Promise<Partial<Report>> {
  const info: Partial<Report> = {
    complaintCount: 0,
    isSpam: -1,
  };

  const reportIdMatch = msg.match(sysRegex.reportId);
  if (reportIdMatch) info.reportId = reportIdMatch[0];

  const complaintMatch = msg.match(sysRegex.complaintCount);
  if (complaintMatch) info.complaintCount = parseInt(complaintMatch[1]);

  const sourceMatch = msg.match(sysRegex.source);
  if (sourceMatch) info.source = sourceMatch[1].trim();

  const senderMatch = msg.match(sysRegex.sender);
  if (senderMatch) info.sender = senderMatch[1].trim();

  const adminMatch = msg.match(sysRegex.admin);
  if (adminMatch) info.adminSender = adminMatch[1].trim();

  return info;
}

// Undo and recovery functions
async function undo(reportId?: string): Promise<void> {
  const recentReportIds = await getRecentReportIds();
  for (const id of recentReportIds) {
    if (reportId && id !== reportId) continue;
    
    const report = await getFromCache(id);
    if (!report) continue;

    const undoCommand = `/undo${id.replace(/\D/g, '')}`;
    log(`Attempting undo for report ${id}`, 'debug');
    await sendToBot(undoCommand);

    await new Promise(resolve => setTimeout(resolve, 2000));

    const lastAddMsg = await redis.get('last_add_msg');
    if (lastAddMsg && (lastAddMsg.includes("Undone") || lastAddMsg.includes("Nothing to undo"))) {
      log(`Successful undo for report ${id}`, 'debug');
      report.decisionSent = false; // Сбрасываем флаг отправки решения
      report.isOpen = true; // Снова открываем отчет
      await saveCache(report);
      return;
    }
  }

  log(`Failed to undo report${reportId ? ` ${reportId}` : ''}`, 'error');
  await notify(`Failed to undo report${reportId ? ` ${reportId}` : ''}. Bot will pause for 2 minutes.`);
  await new Promise(resolve => setTimeout(resolve, 120000)); // 2 minutes pause
  await sendToBot("/next 5");
}

// Admin functions
async function sendStatus() {
  const status = `
Current status:
Auto mode: ${autoMode ? 'On' : 'Off'}
Processing delay: ${COMMAND_DELAY} ms
Database connection: ${await checkDB() ? 'Connected' : 'Disconnected'}
Total processed reports: ${totalProcessedReports}
Average processing time: ${(totalProcessingTime / totalProcessedReports || 0).toFixed(2)} ms
  `;
  await notify(status);
}

async function resetRedisCache(): Promise<void> {
  try {
    log('Attempting to clear Redis cache...', 'debug');
    await redis.flushdb();
    log('Redis cache cleared successfully', 'debug');
    await notify('Redis cache has been cleared successfully');
  } catch (error) {
    logErr('resetRedisCache', error);
    await notify(`Error clearing Redis cache: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleDbCommand() {
  try {
    await notify('Starting database operations. This may take a while...');
    
    // Transfer data from Redis to PostgreSQL
    await saveRedisToPostgres();
    
    // Generate and send CSV report
    const csvData = await generateCsvReport();
    await sendCsvToAdmin(csvData);
    
    await notify('Database operations completed successfully.');
  } catch (error) {
    logErr('handleDbCommand', error);
    await notify(`Error during database operations: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function generateCsvReport(): Promise<string> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT *
      FROM reports
      ORDER BY created_at DESC
      LIMIT 1000
    `);

    const csvFilePath = join(tmpdir(), 'spam_report.csv');
    const csvWriter = createObjectCsvWriter({
      path: csvFilePath,
      header: [
        { id: 'report_id', title: 'ReportID' },
        { id: 'message_content', title: 'MessageContent' },
        { id: 'media_hashes', title: 'MediaHashes' },
        { id: 'complaint_count', title: 'ComplaintCount' },
        { id: 'source', title: 'Source' },
        { id: 'sender', title: 'Sender' },
        { id: 'is_spam', title: 'IsSpam' },
        { id: 'reason', title: 'Reason' },
        { id: 'confidence', title: 'Confidence' },
        { id: 'created_at', title: 'Timestamp' }
      ]
    });

    await csvWriter.writeRecords(result.rows);
    return csvFilePath;
  } finally {
    client.release();
  }
}
  
async function sendCsvToAdmin(csvFilePath: string) {
  await client.sendFile(ADMIN_ID, {
    file: csvFilePath,
    caption: 'Here is the latest spam report.',
    attributes: [
      new Api.DocumentAttributeFilename({ fileName: 'spam_report.csv' })
    ]
  });
}
  
async function checkDB() {
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

// Performance monitoring
function updateMetrics(processingTime: number) {
  totalProcessedReports++;
  totalProcessingTime += processingTime;
  const averageProcessingTime = totalProcessingTime / totalProcessedReports;
  log(`Performance: Avg processing time: ${averageProcessingTime.toFixed(2)}ms, Total reports: ${totalProcessedReports}`, 'info');
}
  
// System health check
async function checkSystemHealth() {
  try {
    // Check Redis connection
    await redis.ping();

    // Check PostgreSQL connection
    const dbClient = await pool.connect();
    try {
      await dbClient.query('SELECT 1');
    } finally {
      dbClient.release();
    }

    // Check Telegram connection
    if (!client) {
      throw new Error('Telegram client not initialized');
    }
    
    // Use a method to check if the client is connected
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
  
// Setup handlers
async function setupHandlers() {
  if (!botEntity) throw new Error('Bot entity not initialized');
  const botUserId = botEntity.userId.toString();

  const handlers = [
    { 
      handler: handleCheck, 
      options: { fromUsers: [botUserId], incoming: true, forwards: true } 
    },
    { 
      handler: handleSys, 
      options: { fromUsers: [botUserId], incoming: true, forwards: false, pattern: /Sender:|Admin:/ } 
    },
    { 
      handler: handleAdmin, 
      options: { fromUsers: [ADMIN_ID], incoming: true, forwards: false }
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

  // Add separate handler for filtering messages in handleAddMsg
  client.addEventHandler(async (event) => {
    if (event.message instanceof Api.Message &&
        event.message.senderId?.toString() === botUserId &&
        event.message.message &&
        !event.message.message.includes('Sender:') &&
        !event.message.message.includes('Admin:')) {
      await handleAddMsg(event);
    }
  }, new NewMessage({ fromUsers: [botUserId], incoming: true, forwards: false }));

  log('All event handlers set up successfully', 'info');
}
  
// Graceful shutdown
async function gracefulShutdown() {
  log('Starting graceful shutdown...', 'info');

  // Turn off automatic mode
  autoMode = false;
  await notify('Automatic mode stopped due to application shutdown.');

  try {
    await pool.end();
    log('Database connection closed', 'info');
  } catch (error) {
    logErr('gracefulShutdown - closing database connection', error);
  }

  try {
    if (client) {
      await client.disconnect();
      log('Telegram client disconnected', 'info');
    }
  } catch (error) {
    logErr('gracefulShutdown - disconnecting Telegram client', error);
  }

  try {
    await redis.quit();
    log('Redis connection closed', 'info');
  } catch (error) {
    logErr('gracefulShutdown - closing Redis connection', error);
  }

  log('Graceful shutdown completed', 'info');
  await notify('Application has been shut down gracefully.');
  process.exit(0);
}
  
// Main function
async function main() {
  try {
    log('Starting application...', 'info');

    // Check database version
    await checkDBVersion();

    // Initialize database
    await initDB();
    log('Database initialized successfully', 'info');

    // Initialize Redis connection
    await redis.ping();
    log('Successfully connected to Redis', 'info');

    // Initialize Telegram client
    client = await initClient();
    log('Telegram client initialized', 'info');

    // Initialize bot entity
    await initBot();
    await checkBotConnection();

    // Setup event handlers
    await setupHandlers();

    // Start Express server
    app.listen(PORT, () => log(`Server running on port ${PORT}`, 'info'));

    // Schedule periodic tasks
    schedule.scheduleJob('0 */2 * * *', saveRedisToPostgres);
    schedule.scheduleJob('*/15 * * * *', checkSystemHealth);
    schedule.scheduleJob('*/5 * * * *', limitCacheSize);

    // Set up error handling
    process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
      log('UnhandledRejection', 'error');
      log(`Reason: ${reason}`, 'error');
    });

    process.on('uncaughtException', (error: Error) => {
      logErr('UncaughtException', error);
    });

    // Set up graceful shutdown
    process.on('SIGINT', async () => {
      log('Received SIGINT. Shutting down gracefully', 'info');
      await gracefulShutdown();
    });

    process.on('SIGTERM', async () => {
      log('Received SIGTERM. Shutting down gracefully', 'info');
      await gracefulShutdown();
    });

    await notify('Application initialized successfully');
    await sendStatus(); // Send initial status to admin

    // // Start processing reports
    // if (autoMode) {
    //   openNew();
    //   await sendToBot("/next 7");
    // }

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

export { app };