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
const BUFFER_DELAY = 100; // 100 ms
const MAX_PROCESSING_TIME = 30000; // 30 seconds

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
let messageBuffer: Array<{type: 'check' | 'sys', content: string, reportId?: string, timestamp: number}> = [];
let bufferTimeout: NodeJS.Timeout | null = null;
let currentReportId: string | null = null;

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
  isOpen: boolean;
  decisionSent: boolean;
  gptChecked?: boolean;
}

type SpamDecision = {
  isSpam: number;
  reason: string;
  confidence: number;
  checkType: 'fast' | 'gpt' | 'default';
};

// Regular expressions
const sysRegex = {
  reportId: /#r(\d+)/,
  complaintCount: /😱(\d+)/,
  source: /^(?:🗣\s*)?Source:\s*(.+)/m,
  sender: /^Sender:\s*(.+)/m,
};

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
  if (!botEntity) throw new Error('Bot entity not initialized');
  await retry(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        client.sendMessage(botEntity!, { message });
        resolve();
      }, COMMAND_DELAY);
    });
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

// Message handling functions
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
    message.senderId?.toString() === botEntity.userId.toString() &&
    message.forwards
  ) {
    log(`Received message for check: ${message.message}`, 'debug');

    const processedMessage = preprocess(message.message || '');
    messageBuffer.push({type: 'check', content: processedMessage, timestamp: Date.now()});

    if (message.media) {
      try {
        const mediaHash = await getHash(message.media);
        messageBuffer.push({type: 'check', content: `media:${mediaHash}`, timestamp: Date.now()});
        await downloadAndStoreMedia(message.media);
      } catch (error) {
        logErr('handleCheck - getting media hash', error);
      }
    }

    scheduleProcessing();
  }
}

async function handleSys(event: NewMessageEvent) {
  const { message } = event;
  if (
    message instanceof Api.Message &&
    event.isPrivate &&
    botEntity &&
    message.senderId?.toString() === botEntity.userId.toString() &&
    message.message?.includes('Source:')
  ) {
    log(`Received system message: ${message.message}`, 'debug');

    const sysInfo = parseSysMessage(message.message || '');
    if (sysInfo.reportId) {
      messageBuffer.push({
        type: 'sys',
        content: message.message || '',
        reportId: sysInfo.reportId,
        timestamp: Date.now()
      });
      scheduleProcessing();
    } else {
      log('Received system message without reportId', 'error');
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
    log(`Received additional message: ${message.message}`, 'debug');

    const messageContent = message.message || '';
    if (messageContent.includes("Hello there! Send /next to start processing reports.")) {
      if (autoMode) {
        await sendToBot("/next 6");
      }
    } else if (messageContent.includes("No Reports Found")) {
      log('No reports found, applying undo', 'debug');
      await undo();
    } else if (messageContent.includes("Please select 😡 BAN or 😌 NO.") ||
               messageContent.includes("Sorry, an error has occurred during your request. Please try again later.")) {
      await undo();
    }
  }
}

// Report processing functions
async function processBuffer(currentTimestamp: number) {
  const sysMsg = messageBuffer.find(msg => msg.type === 'sys');
  const checkMsgs = messageBuffer.filter(msg => msg.type === 'check');

  if (sysMsg && sysMsg.reportId) {
    const report = createReport(sysMsg, checkMsgs);
    await saveCache(report);
    await processReport(report);
  }

  messageBuffer = [];
}

async function processReport(report: Report): Promise<void> {
  log(`Starting to process report ${report.reportId}`, 'debug');
  let decision: SpamDecision | null = null;

  const timer = setTimeout(() => {
    log(`Processing time exceeded ${MAX_PROCESSING_TIME}ms for report ${report.reportId}`, 'debug');
    undo().catch(error => logErr('undo in timer', error));
  }, MAX_PROCESSING_TIME);

  try {
    if (report.decisionSent) {
      log(`Decision already sent for report ${report.reportId}, skipping processing`, 'debug');
      return;
    }

    decision = await checkCache(report.reportId);
    if (decision) {
      log(`Using cached decision for report ${report.reportId}`, 'debug');
      await applyDecision(report, decision);
      return;
    }

    if (!decision) {
      decision = await fastCheck(report);
      if (decision) {
        log(`Fast check decision for report ${report.reportId}: ${JSON.stringify(decision)}`, 'debug');
        await applyDecision(report, decision);
        return;
      }
    }

    if (!decision) {
      decision = await gptCheck(report);
      if (decision) {
        log(`GPT check decision for report ${report.reportId}: ${JSON.stringify(decision)}`, 'debug');
        await applyDecision(report, decision);
        return;
      }
    }

    if (!decision) {
      log(`No decision made for ${report.reportId}, marking as not spam`, 'debug');
      decision = {
        isSpam: 0,
        reason: "No spam detected after all checks",
        confidence: 60,
        checkType: 'default'
      };
      await applyDecision(report, decision);
    }
  } catch (error) {
    logErr('processReport', error);
    await notify(`Error processing report ${report.reportId}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function fastCheck(report: Report): Promise<SpamDecision | null> {
  const hasLinksOrContacts = report.messageContent.some(msg => 
    msg.includes('http') || msg.includes('@') || /\+?\d{10,}/.test(msg)
  );
  const hasMedia = report.mediaHashes.length > 0;
  
  if ((hasLinksOrContacts || hasMedia) && report.complaintCount > 2) {
    return { 
      isSpam: 1, 
      reason: "Fast check: Links/contacts/media with >2 complaints", 
      confidence: 90, 
      checkType: 'fast' 
    };
  }

  const hasInlineKeyboard = report.mediaHashes.some(hash => hash.startsWith('inline_keyboard:'));
  const hasStory = report.mediaHashes.some(hash => hash.startsWith('story:'));

  if (hasInlineKeyboard || hasStory) {
    return { 
      isSpam: 1, 
      reason: "Fast check: Inline keyboard/story", 
      confidence: 85, 
      checkType: 'fast' 
    };
  }

  return null;
}

async function gptCheck(report: Report): Promise<SpamDecision | null> {
  const gptPrompt = `As an AI trained in commercial spam detection for Telegram groups, analyze the provided information for potential spam in any language. Consider all aspects, including content, context, metadata, and visual elements. Be cautious and conservative in your assessment to minimize false positives.

Guidelines for spam classification:
1. Commercial Spam:
   - Unsolicited ads, subtle marketing
   - Self-promotion of unrelated channels/groups
   - Disguised promotions (e.g., informative messages with channel links)
2. Scams/Financial:
   - Phishing, fake giveaways, get-rich-quick schemes
   - Unrealistic financial promises, urgent decisions
   - Suspicious cryptocurrency/airdrop mentions
   - Offers of quick money or short-term "jobs"
3. Deceptive/Adult Content:
   - Impersonation, false promises
   - Explicit content, unsolicited services
   - Subtle invitations for private meetings, coded language
   - Requests for private photos/information
   - Encrypted messages like "GV、TN、TF、CP 指數無限賣出" (likely adult content sales)
   - Phrases like "я свободна" or "available" in context of potential sexual services
4. Unwanted Content:
   - Chain messages, excessive invites
   - Unsolicited job offers, surveys, personal requests
5. Suspicious Behavior:
   - Bot-like messages, repetitive content
   - Attempts to move conversations to private channels
   - Excessive emojis, especially at line starts
6. Harmful Content:
   - Incitement to violence/illegal activities
   - Sharing others' personal information
7. Any message with clear spam indicators

Not Spam:
1. Normal interactions (greetings, casual conversation, jokes)
2. Short messages, single words, numbers, or emojis (unless part of a suspicious pattern)
3. Questions, replies, opinions, reactions
4. Legitimate information (relevant news, educational content)
5. Group-related activities (relevant polls, discussions)
6. Expressive language (profanity, emotional outbursts, arguments, rudeness, aggression, discrimination, hate speech, insults)
7. Cultural content (local slang, cultural references)
8. Warnings about scams/spam (educational context)
9. Any message without clear spam indicators
10. Bot commands (starting with "/"), unless they have 3 or more complaints
11. Political discussions, especially in Russian, even if aggressive or insulting

Key Factors to Consider:
1. Message content and intent in any language
2. Presence and nature of links or media
3. Language tone and message structure
4. Relevance to typical group conversations
5. Provided context (complaints, source, sender's country flag)
6. Cultural and linguistic context

Important Notes:
- Normal conversations, including casual chat and emoji usage, are not spam
- Offensive language or aggression alone are not indicators of spam
- Messages with high complaint counts should be scrutinized carefully, but complaint count alone is not definitive proof of spam
- Sharing of links or information is not automatically spam, but context is crucial
- Be extra cautious with messages offering quick money or short-term "jobs", especially if they mention specific amounts
- Text with non-Latin characters (e.g., Chinese, Japanese) should be scrutinized more carefully, as it's often suspicious in certain contexts
- Aggressive political discussions or insults, especially in Russian, are typically not spam
- The sender's country flag (provided in the "Sender" field) can offer context for cultural references
- Any discussions of business or finances are more likely to be spam and should be carefully evaluated
- Encrypted or coded messages, especially those resembling adult content sales, should be classified as spam
- Phrases indicating availability for meetings, especially in contexts that suggest sexual services, should be treated as potential spam

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
        model: "gpt-4o-mini",
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
    // Process media content
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
              model: "gpt-4o-mini",
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

async function isGPT4VisionCompatible(mediaHash: string): Promise<boolean> {
  const GPT4VisionCompatibleMedia = ['photo', 'sticker', 'gif', 'video', 'videonote'];
  const mediaType = mediaHash.split(':')[0];
  return GPT4VisionCompatibleMedia.includes(mediaType);
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

// Helper functions
function preprocess(message: string): string {
  const lines = message.split('\n');
  return lines.slice(1).join('\n').trim();
}

function scheduleProcessing() {
  if (bufferTimeout) {
    clearTimeout(bufferTimeout);
  }
  bufferTimeout = setTimeout(() => processBuffer(Date.now()), BUFFER_DELAY);
}

function createReport(sysMsg: any, checkMsgs: any[]): Report {
  const sysInfo = parseSysMessage(sysMsg.content);
  return {
    reportId: sysInfo.reportId!,
    messageContent: checkMsgs.filter(msg => !msg.content.startsWith('media:')).map(msg => msg.content),
    mediaHashes: checkMsgs.filter(msg => msg.content.startsWith('media:')).map(msg => msg.content.slice(6)),
    complaintCount: sysInfo.complaintCount || 0,
    source: sysInfo.source || '',
    sender: sysInfo.sender || '',
    isSpam: -1,
    timestamp: Date.now(),
    isOpen: true,
    decisionSent: false
  };
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
    prompt += "\nNote: No message content available.";
  }

  return prompt;
}

async function applyDecision(report: Report, decision: SpamDecision): Promise<void> {
  log(`Applying decision for ${report.reportId}: ${JSON.stringify(decision)}`, 'debug');
  
  if (report.decisionSent) {
    log(`Decision already sent for report ${report.reportId}, skipping`, 'debug');
    return;
  }
  
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
  log(`Updated report saved to cache: ${report.reportId}`, 'debug');
}

async function sendDecision(report: Report, decision: SpamDecision): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 100)); // Задержка 100 мс
  await sendToBot(decision.isSpam ? '😡 SPAM' : '😌 NO');
  log(`Sent decision: ${decision.isSpam ? 'SPAM' : 'NOT SPAM'}`, 'debug');
  report.decisionSent = true;
  await saveCache(report);
  log(`Decision sent for report ${report.reportId}`, 'debug');
}

// Cache functions
async function saveCache(report: Report): Promise<void> {
  const cacheKey = `report:${report.reportId}`;
  await redis.set(cacheKey, JSON.stringify(report), 'EX', 86400); // Cache for 24 hours

  log(`Report ${report.reportId} saved to cache`, 'debug');
}

async function checkCache(reportId: string): Promise<SpamDecision | null> {
  log(`Checking cache for report ${reportId}`, 'debug');
  const cacheKey = `report:${reportId}`;
  const cachedReport = await redis.get(cacheKey);
  
  if (cachedReport) {
    const report = JSON.parse(cachedReport) as Report;
    if (report.isSpam !== -1) {
      log(`Found cached decision for report ${reportId}: isSpam=${report.isSpam}`, 'debug');
      return {
        isSpam: report.isSpam,
        reason: report.reason || "Cached decision",
        confidence: report.confidence || 100,
        checkType: 'fast'
      };
    }
  }

  log(`No cached decision found for report ${reportId}`, 'debug');
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

// Media handling functions
async function getHash(media: Api.TypeMessageMedia): Promise<string> {
  if (media instanceof Api.MessageMediaEmpty) return 'empty';
  if (media instanceof Api.MessageMediaPhoto) return `photo:${media.photo?.id || 'unknown'}`;
  if (media instanceof Api.MessageMediaDocument) {
    const document = media.document;
    if (document instanceof Api.Document) {
      const fileType = document.mimeType.split('/')[0];
      const attribute = document.attributes.find(attr => 
        attr instanceof Api.DocumentAttributeSticker ||
        attr instanceof Api.DocumentAttributeAnimated ||
        attr instanceof Api.DocumentAttributeVideo
      );
      if (attribute instanceof Api.DocumentAttributeSticker) return `sticker:${document.id}`;
      if (attribute instanceof Api.DocumentAttributeAnimated) return `gif:${document.id}`;
      if (attribute instanceof Api.DocumentAttributeVideo) {
        return attribute.roundMessage ? `videonote:${document.id}` : `video:${document.id}`;
      }
      return `${fileType}:${document.id}`;
    }
  }
  return `unknown:${media.className}`;
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

// Undo function
async function undo(): Promise<void> {
  log(`Attempting undo`, 'debug');
  await sendToBot("/undo");
  log(`Undo command sent`, 'debug');
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
    const command = message.message.toLowerCase();

    switch (true) {
      case command === '/start':
        autoMode = true;
        await notify('Automatic mode started');
        await sendToBot("/next 6");
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

async function sendStatus() {
  const status = `
Current status:
Auto mode: ${autoMode ? 'On' : 'Off'}
Processing delay: ${COMMAND_DELAY} ms
Database connection: ${await checkDB() ? 'Connected' : 'Disconnected'}
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

// Database functions
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        report_id TEXT UNIQUE NOT NULL,
        message_content TEXT[],
        media_hashes TEXT[],
        complaint_count INTEGER NOT NULL,
        source TEXT NOT NULL,
        sender TEXT NOT NULL,
        is_spam INTEGER,
        reason TEXT,
        confidence FLOAT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
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

    await client.query('COMMIT');
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
            report.confidence,
            new Date(report.timestamp)
          ];
        });

        const query = `
          INSERT INTO reports (report_id, message_content, media_hashes, complaint_count, source, sender, is_spam, reason, confidence, created_at)
          VALUES ${values.map((_, index) => `($${index * 10 + 1}, $${index * 10 + 2}, $${index * 10 + 3}, $${index * 10 + 4}, $${index * 10 + 5}, $${index * 10 + 6}, $${index * 10 + 7}, $${index * 10 + 8}, $${index * 10 + 9}, $${index * 10 + 10})`).join(', ')}
          ON CONFLICT (report_id) DO UPDATE SET
          message_content = EXCLUDED.message_content,
          media_hashes = EXCLUDED.media_hashes,
          complaint_count = EXCLUDED.complaint_count,
          source = EXCLUDED.source,
          sender = EXCLUDED.sender,
          is_spam = EXCLUDED.is_spam,
          reason = EXCLUDED.reason,
          confidence = EXCLUDED.confidence
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
      options: { fromUsers: [botUserId], incoming: true, forwards: true } 
    },
    { 
      handler: handleSys, 
      options: { fromUsers: [botUserId], incoming: true, forwards: false, pattern: /Source:/ } 
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

  // Add separate handler for filtering messages in handleAdd
  client.addEventHandler(async (event) => {
    if (event.message instanceof Api.Message &&
        event.message.senderId?.toString() === botUserId &&
        event.message.message &&
        !event.message.message.includes('Source:')) {
      await handleAdd(event);
    }
  }, new NewMessage({ fromUsers: [botUserId], incoming: true, forwards: false }));

  log('All event handlers set up successfully', 'info');
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

  // Cleanup Redis
  const keys = await redis.keys('report:*');
  for (const key of keys) {
    const report = JSON.parse(await redis.get(key) || '{}');
    if (new Date(report.timestamp) < oneMonthAgo) {
      await redis.del(key);
    }
  }

  // Cleanup PostgreSQL
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM reports WHERE created_at < $1', [oneMonthAgo]);
  } finally {
    client.release();
  }

  log('Cleanup of old data completed', 'info');
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

    // Setup event handlers
    await setupHandlers();

    // Start Express server
    app.listen(PORT, () => log(`Server running on port ${PORT}`, 'info'));

    // Schedule periodic tasks
    schedule.scheduleJob('0 */2 * * *', saveRedisToPostgres);
    schedule.scheduleJob('*/15 * * * *', checkSystemHealth);
    schedule.scheduleJob('*/5 * * * *', limitCacheSize);
    schedule.scheduleJob('0 2 * * *', cleanupOldData); // Run cleanup every day at 2:00 AM

    // Set up error handling
    process.on('uncaughtException', async (error) => {
      logErr('Uncaught Exception', error);
      await notify(`Uncaught Exception: ${error.message}. Attempting to recover...`);
      await gracefulShutdown();
    });

    process.on('unhandledRejection', async (reason, promise) => {
      logErr('Unhandled Rejection', reason);
      await notify(`Unhandled Rejection: ${reason}. Attempting to recover...`);
      await gracefulShutdown();
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

    // Start processing reports if in auto mode
    if (autoMode) {
      await sendToBot("/next 6");
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