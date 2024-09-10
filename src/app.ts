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
import fs from 'fs';

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
let COMMAND_DELAY = 200;
const MAX_CACHE_SIZE = 10000;
const DB_SCHEMA_VERSION = '1.0';
const MEDIA_EXPIRY = 30; // 30 seconds
const ENABLE_GPT_MEDIA_ANALYSIS = true;
const BUFFER_DELAY = 100; // 100 ms
const MAX_PROCESSING_TIME = 55000; // 55 seconds
const CACHE_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_SIZE_MB = 100; // 100 MB

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
let messageBuffer: BufferItem[] = [];
let bufferTimeout: NodeJS.Timeout | null = null;
let undoTimers: UndoTimer[] = [];

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
  confidence?: number;
  timestamp: number;
  decisionSent?: boolean;
  isOpen?: boolean;
  replyTo?: number;
}

type SpamDecision = {
  isSpam: number;
  reason: string;
  confidence: number;
  checkType: 'fast' | 'gpt' | 'default';
};

type UndoTimer = {
  reportId: string;
  timer: NodeJS.Timeout;
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
  await retry(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        client.sendMessage(botEntity!, { message });
        resolve();
      }, COMMAND_DELAY);
    });
  });
  log(`Sent message to bot: ${message}`, 'debug');
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

// Message handling functions
async function handleCheck(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && event.isPrivate && botEntity && message.senderId?.toString() === botEntity.userId.toString()) {
    log(`Received check message: ${message.message}`, 'debug');
    
    let messageContent = message.message || '';
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
        if (captionText) {
          messageContent = messageContent ? `${messageContent}\n${captionText}` : captionText;
          log(`Caption found in media: ${captionText}`, 'debug');
        }

        if (message.media instanceof Api.MessageMediaDocument) {
          const document = message.media.document;
          if (document instanceof Api.Document) {
            const attribute = document.attributes.find(attr => 
              attr instanceof Api.DocumentAttributeVideo ||
              attr instanceof Api.DocumentAttributeAudio ||
              attr instanceof Api.DocumentAttributeAnimated
            );
            if (attribute) {
              log(`Media type detected: ${attribute.className}`, 'debug');
            }
          }
        }
      }

      mediaKey = `media:${message.media instanceof Api.MessageMediaPhoto ? message.media.photo?.id : (message.media instanceof Api.MessageMediaDocument ? message.media.document?.id : 'unknown')}`;
      log(`Media key generated: ${mediaKey}`, 'debug');
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
      replyTo: message.replyTo?.replyToMsgId
    };

    if (mediaKey !== null) {
      bufferItem.mediaKey = mediaKey;
    }

    messageBuffer.push(bufferItem);

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
    message.senderId?.toString() === botEntity.userId.toString() &&
    message.message?.match(sysRegex.source)
  ) {
    log(`Received system message: ${message.message}`, 'debug');

    const sysInfo = parseSysMessage(message.message || '');
    if (sysInfo.reportId) {
      messageBuffer.push({
        type: 'sys',
        content: message.message || '',
        reportId: sysInfo.reportId,
        timestamp: Date.now(),
        replyTo: message.replyTo?.replyToMsgId
      });
      scheduleProcessing();
      
      const timer = setTimeout(() => checkAndUndo(sysInfo.reportId!), 10000);
      undoTimers.push({ reportId: sysInfo.reportId, timer });
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
    const messageContent = message.message || '';
    if (messageContent.includes("Hello there! Send /next to start processing reports.")) {
      if (autoMode) {
        await sendToBot("/next 3");
      }
    } else if (messageContent.includes("Please select 😡 BAN or 😌 NO.") ||
               messageContent.includes("Sorry, an error has occurred during your request. Please try again later.") ||
               messageContent.includes("No Reports Found")) {
      await undo();
    } else if (messageContent.includes("marked as spam 😡") || messageContent.includes("marked as not spam 😌")) {
      const reportIdMatch = messageContent.match(/#r(\d+)/);
      if (reportIdMatch) {
        const reportId = reportIdMatch[1];
        const cachedReport = await redis.get(`report:${reportId}`);
        if (cachedReport) {
          const report = JSON.parse(cachedReport) as Report;
          const expectedDecision = messageContent.includes("marked as spam 😡") ? 1 : 0;
          if (report.isSpam !== expectedDecision) {
            log(`Mismatch in decision for report ${reportId}. Expected: ${expectedDecision}, Actual: ${report.isSpam}`, 'warn');
          }
        }
      }
    }
  }
}

// Report processing functions
async function processBuffer(currentTimestamp: number) {
  log(`Processing buffer at timestamp ${currentTimestamp}`, 'debug');
  
  const checkMessages = messageBuffer.filter(msg => msg.type === 'check' && msg.timestamp <= currentTimestamp);
  const sysMessages = messageBuffer.filter(msg => msg.type === 'sys' && msg.timestamp <= currentTimestamp);

  for (const sysMsg of sysMessages) {
    let matchingCheckMsg = checkMessages.find(checkMsg => checkMsg.replyTo === sysMsg.replyTo);
    
    if (!matchingCheckMsg) {
      matchingCheckMsg = checkMessages.find(checkMsg => 
        Math.abs(checkMsg.timestamp - sysMsg.timestamp) < 1000
      );
    }

    if (matchingCheckMsg && sysMsg.reportId) {
      const undoTimer = undoTimers.find(ut => ut.reportId === sysMsg.reportId);
      if (undoTimer) {
        clearTimeout(undoTimer.timer);
        undoTimers = undoTimers.filter(ut => ut.reportId !== sysMsg.reportId);
      }

      scheduleDelayedProcessing(sysMsg, matchingCheckMsg);
    }
  }
}

async function processReport(report: Report): Promise<void> {
  log(`Processing report ${report.reportId}`, 'debug');
  
  let decision: SpamDecision | null = null;
  const processingStartTime = Date.now();

  try {
    decision = await checkCache(report.reportId);
    if (decision) {
      log(`Cache hit for report ${report.reportId}`, 'debug');
      await applyDecision(report, decision);
      return;
    }

    decision = await fastCheck(report);
    if (decision) {
      log(`Fast check decision for report ${report.reportId}: ${JSON.stringify(decision)}`, 'debug');
      await applyDecision(report, decision);
      return;
    }

    if (report.mediaHashes.length > 0) {
      const checkMsg = messageBuffer.find(msg => msg.type === 'check' && msg.replyTo === report.replyTo);
      if (checkMsg && checkMsg.mediaKey) {
        const media = await getMediaFromMessage(report.replyTo!);
        if (media) {
          await downloadAndStoreMedia(media, checkMsg.mediaKey);
        }
      }
    }

    decision = await gptCheck(report);
    if (decision) {
      await applyDecision(report, decision);
      return;
    }

    decision = { isSpam: 0, reason: "No spam detected", confidence: 50, checkType: 'default' };
    await applyDecision(report, decision);

  } catch (error) {
    logErr(`processReport for ${report.reportId}`, error);
    await undo();
  } finally {
    const processingTime = Date.now() - processingStartTime;
    if (processingTime > MAX_PROCESSING_TIME) {
      log(`Processing time exceeded for report ${report.reportId}. Time taken: ${processingTime}ms`, 'warn');
      await undo();
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
  
  const hasPhoto = report.mediaHashes.some(hash => hash.startsWith('photo:'));

  if ((hasLinksOrContacts && report.complaintCount > 2) || 
      hasDangerousFile || 
      hasInlineKeyboard || 
      hasStory || 
      (hasPhoto && report.complaintCount > 2)) {
    let reason = "Fast check:";
    if (hasLinksOrContacts && report.complaintCount > 2) reason += " Links/contacts with >2 complaints";
    if (hasDangerousFile) reason += " Dangerous file detected";
    if (hasInlineKeyboard) reason += " Inline keyboard detected";
    if (hasStory) reason += " Story detected";
    if (hasPhoto && report.complaintCount > 2) reason += " Photo with >2 complaints";

    log(`Fast check detected spam for report ${report.reportId}: ${reason}`, 'debug');
    return { 
      isSpam: 1, 
      reason: reason.trim(), 
      confidence: 90, 
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

    if (message && message.media) {
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
  log(`Starting GPT check for report ${report.reportId}`, 'debug');

  const gptPrompt = `As an AI trained in commercial spam detection for Telegram groups, analyze the provided information for potential spam in any language. Consider all aspects, including content, context, metadata, and visual elements. Be cautious and conservative in your assessment to minimize false positives. You must provide a definitive answer: either 1 (spam) or 0 (not spam).

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
   - Subtle invitations for private meetings, coded language for sexual services
   - Requests for private photos/information
   - Encrypted messages like "GV、TN、TF、CP 指數無限賣出" (likely adult content sales)
   - Phrases like "я свободна" or "available" in context of potential sexual services
   - Suggestive or flirtatious messages that seem out of context
   - Euphemisms or innuendos commonly used to disguise sexual content
4. Unwanted Content:
   - Chain messages, excessive invites
   - Unsolicited job offers, surveys, personal requests
   - Requests to write in private messages (e.g., "write + in private") are often associated with spam or scams
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
8. Warnings about scams/spam
9. Any message without clear spam indicators
10. Bot commands (starting with "/"), unless they have 3 or more complaints
11. Political discussions, especially in Russian or Ukrainian, even if aggressive or insulting
12. Emotional or exaggerated messages that don't promote products or services

Key Factors to Consider:
1. Message content and intent in any language
2. Presence and nature of links or media
3. Language tone and message structure
4. Relevance to typical group conversations
5. Provided context (complaints, source, sender's country flag)
6. Cultural and linguistic context
7. Group's theme and purpose

Important Notes:
- Normal conversations, including casual chat and emoji usage, are not spam
- Offensive language or aggression alone are not indicators of spam
- Messages with high complaint counts should be scrutinized carefully, but complaint count alone is not definitive proof of spam
- Sharing of links or information is not automatically spam, but context is crucial
- Be extra cautious with messages offering quick money or short-term "jobs", especially if they mention specific amounts
- Text with non-Latin characters (e.g., Chinese, Japanese) should be scrutinized more carefully, as it's often suspicious in certain contexts
- Aggressive political discussions or insults, especially in Russian or Ukrainian, are typically not spam
- The sender's country flag (provided in the "Sender" field) can offer context for cultural references
- Any discussions of business or finances are more likely to be spam and should be carefully evaluated
- Encrypted or coded messages, especially those resembling adult content sales, should be classified as spam
- Phrases indicating availability for meetings, especially in contexts that suggest sexual services, should be treated as potential spam
- Pay close attention to subtle sexual innuendos or euphemisms that may indicate hidden adult content
- Short messages or single characters (like "+") are not spam unless they are part of a clear spam pattern or have a high complaint count
- Consider the group's theme when evaluating potentially controversial or adult content
- Political discussions, even if aggressive or containing insults, are generally not spam unless they include clear spam indicators
- Emotional or exaggerated messages about updates, news, or events are not necessarily spam if they don't promote products or services

Classify the information as either spam (1) or not spam (0). Provide a confidence score from 0 to 100, where 100 is absolute certainty.

Output your response in the following format:
classification,confidence

Example outputs:
1,95
0,80

Your analysis:`;

  const mediaPrompt = `As an AI trained in commercial spam detection for Telegram groups, analyze the provided image for potential spam. Focus on visual elements that may indicate unsolicited advertising, promotional content, or affiliate marketing.

Guidelines for image spam classification:
1. Look for clear visual indicators of commercial spam such as promotional banners, product advertisements, or marketing materials.
2. Check for text overlays that promote products, services, or websites.
3. Assess the presence of QR codes or barcodes that may lead to promotional content.
4. Evaluate any logos or branding elements that seem out of context or overtly commercial.
5. Consider the overall composition and purpose of the image in the context of a Telegram group.
6. Be cautious of images that may contain subtle or explicit sexual content.
7. Pay attention to screenshots of conversations or apps that might be promoting specific services or products.

Classify the image as either spam (1) or not spam (0). Provide a confidence score from 0 to 100, where 100 is absolute certainty.

Output your response in the following format:
classification,confidence

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

    if (report.messageContent.length > 0) {
      const textResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: textMessages,
        max_tokens: 5,
        temperature: 0.1,
      });

      const textContent = textResponse.choices[0]?.message?.content?.trim();
      if (textContent) {
        const [classification, confidence] = textContent.split(',');
        if (classification === '0' || classification === '1') {
          textDecision = {
            isSpam: Number(classification),
            reason: Number(classification) === 1 ? "GPT: spam" : "GPT: not spam",
            confidence: Number(confidence) || 50,
            checkType: 'gpt'
          };
        } else {
          log(`Unexpected GPT response format for report ${report.reportId}: ${textContent}`, 'warn');
          textDecision = {
            isSpam: 0,
            reason: "GPT: inconclusive response",
            confidence: 50,
            checkType: 'gpt'
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

            const mediaResponse = await openai.chat.completions.create({
              model: "gpt-4o-mini",
              messages: mediaMessages,
              max_tokens: 1,
              temperature: 0.2,
            });

            const mediaContent = mediaResponse.choices[0]?.message?.content?.trim();
            log(`GPT media response for report ${report.reportId}, media hash ${mediaHash}: ${mediaContent}`, 'debug');
            if (mediaContent) {
              const [classification, confidence] = mediaContent.split(',');
              mediaDecision = {
                isSpam: classification === '1' ? 1 : 0,
                reason: `GPT media: ${classification === '1' ? 'spam' : 'not spam'}`,
                confidence: Number(confidence) || 50,
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

    if (textDecision && mediaDecision) {
      // If both text and media decisions are available, use the one with higher confidence or prefer spam classification
      return textDecision.confidence >= mediaDecision.confidence ? textDecision : mediaDecision;
    } else if (textDecision) {
      log(`GPT text check decision for report ${report.reportId}: ${JSON.stringify(textDecision)}`, 'debug');
      return textDecision;
    } else if (mediaDecision) {
      log(`GPT media check decision for report ${report.reportId}: ${JSON.stringify(mediaDecision)}`, 'debug');
      return mediaDecision;
    }

    log(`GPT check did not make a decision for report ${report.reportId}`, 'debug');
    return null;
  } catch (error) {
    logErr('gptCheck', error);
    log(`GPT check failed for report ${report.reportId}`, 'debug');
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

function scheduleProcessing() {
  if (bufferTimeout) {
    clearTimeout(bufferTimeout);
  }
  bufferTimeout = setTimeout(() => processBuffer(Date.now()), BUFFER_DELAY);
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
    prompt += "\nNote: No message content available. Analyzing based on context and media.";
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
  if (!autoMode) {
    log(`Decision not sent due to automatic mode being off. Report: ${report.reportId}, Decision: ${decision.isSpam ? 'SPAM' : 'NOT SPAM'}`, 'debug');
    return;
  }

  await new Promise(resolve => setTimeout(resolve, 100)); // Задержка 100 мс
  await sendToBot(decision.isSpam ? '😡 SPAM' : '😌 NO');
  log(`Sent decision: ${decision.isSpam ? 'SPAM' : 'NOT SPAM'}`, 'debug');
  report.decisionSent = true;
  await saveCache(report);
  log(`Decision sent for report ${report.reportId}`, 'debug');
}

// Cache functions
async function saveCache(report: Report): Promise<void> {
  try {
    const key = `report:${report.reportId}`;
    await redis.set(key, JSON.stringify(report), 'EX', 86400); // 24 hours expiry
    log(`Report ${report.reportId} saved to cache`, 'debug');
  } catch (error) {
    logErr('saveCache', error);
  }
}

async function checkCache(reportId: string): Promise<SpamDecision | null> {
  try {
    const key = `report:${reportId}`;
    const cachedReport = await redis.get(key);
    if (cachedReport) {
      const report = JSON.parse(cachedReport) as Report;
      if (report.isSpam !== -1) {
        log(`Cache hit for report ${reportId}`, 'debug');
        return {
          isSpam: report.isSpam,
          reason: report.reason || 'Cached decision',
          confidence: report.confidence || 100,
          checkType: 'default'
        };
      }
    }
  } catch (error) {
    logErr('checkCache', error);
  }
  return null;
}

async function cleanupCache() {
  try {
    const keys = await redis.keys('report:*');
    const now = Date.now();
    let deletedCount = 0;

    for (const key of keys) {
      const report = JSON.parse(await redis.get(key) || '{}') as Report;
      if (now - report.timestamp > 24 * 60 * 60 * 1000) { // 24 hours
        await redis.del(key);
        deletedCount++;
      }
    }

    log(`Cleaned up ${deletedCount} old reports from cache`, 'info');
  } catch (error) {
    logErr('cleanupCache', error);
  }
}

async function getCacheSize(): Promise<number> {
  try {
    const keys = await redis.keys('report:*');
    let totalSize = 0;

    for (const key of keys) {
      const size = await redis.memory('USAGE', key);
      if (size !== null) {
        totalSize += size;
      } else {
        log(`Unable to get memory usage for key: ${key}`, 'warn');
      }
    }

    return totalSize / (1024 * 1024); // Convert to MB
  } catch (error) {
    logErr('getCacheSize', error);
    return 0;
  }
}

async function limitCacheSize() {
  try {
    const currentSize = await getCacheSize();
    log(`Current cache size: ${currentSize.toFixed(2)} MB`, 'debug');

    if (currentSize > MAX_CACHE_SIZE_MB) {
      const keysToRemove = Math.ceil((currentSize - MAX_CACHE_SIZE_MB) / 0.1); // Assuming average report size of 0.1 MB
      const keys = await redis.keys('report:*');
      const oldestKeys = keys.sort().slice(0, keysToRemove);
      
      if (oldestKeys.length > 0) {
        await redis.del(...oldestKeys);
        log(`Removed ${oldestKeys.length} oldest keys from Redis cache`, 'info');
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

// Undo function
async function undo(): Promise<void> {
  log(`Attempting undo`, 'debug');
  await sendToBot("/undo");
  log(`Undo command sent`, 'debug');
}

async function checkAndUndo(reportId: string) {
  const sysMsg = messageBuffer.find(msg => msg.type === 'sys' && msg.reportId === reportId);
  const checkMsg = messageBuffer.find(msg => msg.type === 'check' && msg.replyTo === sysMsg?.replyTo);
  
  if (sysMsg && !checkMsg) {
    log(`No check message found for report ${reportId}. Waiting additional time before undo.`, 'warn');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const delayedCheckMsg = messageBuffer.find(msg => msg.type === 'check' && msg.replyTo === sysMsg?.replyTo);
    if (!delayedCheckMsg) {
      log(`Still no check message found for report ${reportId} after waiting. Executing undo().`, 'warn');
      await undo();
      messageBuffer = messageBuffer.filter(msg => !(msg.type === 'sys' && msg.reportId === reportId));
    } else {
      scheduleDelayedProcessing(sysMsg, delayedCheckMsg);
    }
  } else if (sysMsg && checkMsg) {
    scheduleDelayedProcessing(sysMsg, checkMsg);
  }
  
  undoTimers = undoTimers.filter(ut => ut.reportId !== reportId);
}

function scheduleDelayedProcessing(sysMsg: BufferItem, checkMsg: BufferItem) {
  if (sysMsg.reportId) {
    setTimeout(() => {
      processReport({
        reportId: sysMsg.reportId!,
        messageContent: [checkMsg.content],
        mediaHashes: checkMsg.mediaHashes || [],
        complaintCount: 0,
        source: '',
        sender: '',
        isSpam: -1,
        timestamp: sysMsg.timestamp,
        replyTo: checkMsg.replyTo,
        ...parseSysMessage(sysMsg.content)
      });
      
      messageBuffer = messageBuffer.filter(msg => 
        !(msg.type === 'sys' && msg.reportId === sysMsg.reportId) &&
        !(msg.type === 'check' && msg === checkMsg)
      );
    }, 1000);
  } else {
    log('Cannot schedule delayed processing: sysMsg.reportId is undefined', 'error');
  }
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
        await notify('Automatic mode started. Decisions and bot commands will be sent.');
        await sendToBot("/next 4");
        break;
      case command === '/stop':
        autoMode = false;
        await notify('Automatic mode stopped. Decisions and bot commands will not be sent.');
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
      case command === '/cache':
        await handleCacheCommand();
        break;
      default:
        log(`Unrecognized admin command: ${command}`, 'debug');
        await notify(`Unrecognized command: ${command}`);
    }
  }
}

async function sendStatus() {
  const cacheSize = await getCacheSize();
  const cacheItemCount = await redis.dbsize();
  const status = `
Current status:
Auto mode: ${autoMode ? 'On (decisions and bot commands will be sent)' : 'Off (decisions and bot commands will not be sent)'}
Processing delay: ${COMMAND_DELAY} ms
Database connection: ${await checkDB() ? 'Connected' : 'Disconnected'}
Cache size: ${cacheSize.toFixed(2)} MB
Cache items: ${cacheItemCount}
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
  const keys = await redis.keys('report:*');
  const reports: Report[] = [];

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
      {id: 'confidence', title: 'Confidence'},
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
        confidence FLOAT,
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
            report.confidence,
            new Date(report.timestamp)
          ];
        });

        const query = `
          INSERT INTO reports (report_id, message_content, media_hashes, complaint_count, source, sender, is_spam, reason, confidence, created_at)
          VALUES ${values.map((_, index) => `($${index * 10 + 1}, $${index * 10 + 2}, $${index * 10 + 3}, $${index * 10 + 4}, $${index * 10 + 5}, $${index * 10 + 6}, $${index * 10 + 7}, $${index * 10 + 8}, $${index * 10 + 9}, $${index * 10 + 10})`).join(', ')}
          ON CONFLICT (report_id, created_at) DO UPDATE SET
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
      SELECT 
        report_id,
        message_content[1] as message,
        complaint_count,
        source,
        sender,
        is_spam,
        reason,
        confidence,
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
        {id: 'confidence', title: 'Confidence'},
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
async function gracefulShutdown() {
  log('Starting graceful shutdown...', 'info');

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

    process.on('SIGINT', async () => {
      log('Received SIGINT. Shutting down gracefully', 'info');
      await gracefulShutdown();
    });

    process.on('SIGTERM', async () => {
      log('Received SIGTERM. Shutting down gracefully', 'info');
      await gracefulShutdown();
    });

    log('Application initialized successfully', 'info');
    await notify('Application initialized successfully');
    await sendStatus();

    // if (autoMode) {
    //   log('Starting auto mode', 'info');
    //   await sendToBot("/next 1");
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