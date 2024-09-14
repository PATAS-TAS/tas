import dotenv from 'dotenv';
import pkg from 'pg';
const { Pool } = pkg;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { ChatCompletionCreateParams, ChatCompletionMessageParam } from 'openai/resources/chat/completions';

dotenv.config();

// Environment variables
const DATABASE_URL = process.env.DATABASE_URL!;

// Initialize PostgreSQL pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Interface for the report data
interface Report {
  report_id: string;
  message_content: string[];
  complaint_count: number;
  source: string;
  sender: string;
  is_spam: number;
  media_hashes: string[];
}

// Function to clean and prepare the data
async function prepareData(): Promise<Report[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT 
        report_id,
        message_content,
        complaint_count,
        source,
        sender,
        is_spam,
        media_hashes
      FROM reports
      WHERE is_spam IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 10000
    `);

    return result.rows.map((row: any) => ({
      ...row,
      message_content: row.message_content.filter((msg: string) => msg.trim() !== ''),
    }));
  } finally {
    client.release();
  }
}

// Function to create fine-tuning examples
function createFineTuningExample(report: Report): ChatCompletionCreateParams {
  const systemMessage = `Classify Telegram multilingual messages as spam (1) or not spam (0). Analyze:

1. Message content and context
2. Metadata: complaint count, source, sender, media types ('Source' field used for context, not spam evaluation)

Spam indicators:
- Unsolicited commercial content, phishing, explicit material
- Attempts to move conversations to private channels
- Excessive repetition, multiple links, unsolicited job offers
- Explicit sexual content or coded invitations for sexual services

Non-spam indicators:
- Normal conversations, greetings, legitimate information sharing
- Cultural content, political discussions (especially in Russian or Ukrainian)
- Bot commands, short messages in ongoing chats
- Expressive language, including aggressive profanity

Respond only with 0 (not spam) or 1 (spam).`;

  const userMessage = `Message: ${report.message_content.join('\n')}
Complaint count: ${report.complaint_count}
Source: ${report.source}
Sender: ${report.sender}
Media types: ${report.media_hashes.map(hash => hash.split(':')[0]).join(', ') || 'None'}`;

  return {
    model: "gpt-4o-mini-2024-07-18",
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage },
      { role: "assistant", content: report.is_spam.toString() }
    ],
    temperature: 0.1,
    max_tokens: 1,
    stream: false
  };
}

function estimateMessageLength(message: ChatCompletionMessageParam): number {
  if (typeof message.content === 'string') {
    return message.content.length;
  } else if (Array.isArray(message.content)) {
    return message.content.reduce((contentSum, part) => {
      return contentSum + estimateContentPartLength(part);
    }, 0);
  } else if (message.content === null || message.content === undefined) {
    return 0;
  } else {
    console.warn('Unexpected message content type:', typeof message.content);
    return 0;
  }
}

function estimateContentPartLength(part: unknown): number {
  if (typeof part === 'string') {
    return part.length;
  } else if (typeof part === 'object' && part !== null) {
    if ('type' in part && typeof part.type === 'string') {
      switch (part.type) {
        case 'text':
          return 'text' in part && typeof part.text === 'string' ? part.text.length : 0;
        case 'image_url':
          return 100;
        default:
          console.warn('Unexpected content part type:', part.type);
          return 0;
      }
    } else {
      console.warn('Content part object does not have a valid "type" property:', part);
      return 0;
    }
  } else {
    console.warn('Unexpected content part:', part);
    return 0;
  }
}

function estimateTokenCount(example: ChatCompletionCreateParams): number {
  const totalCharacters = example.messages.reduce((sum, message) => {
    return sum + estimateMessageLength(message);
  }, 0);
  return Math.ceil(totalCharacters / 4); // Грубая оценка: 1 токен ≈ 4 символа
}

// Function to split data into chunks of approximately 1 million tokens
function splitDataIntoChunks(data: ChatCompletionCreateParams[]): ChatCompletionCreateParams[][] {
  console.log(`Starting to split ${data.length} examples into chunks...`);
  const chunks: ChatCompletionCreateParams[][] = [];
  let currentChunk: ChatCompletionCreateParams[] = [];
  let currentTokenCount = 0;
  const TARGET_CHUNK_SIZE = 1000000; // 1 million tokens

  for (const example of data) {
    const tokenCount = estimateTokenCount(example);
    if (currentTokenCount + tokenCount > TARGET_CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push(currentChunk);
      console.log(`Chunk created with ${currentChunk.length} examples and approximately ${currentTokenCount} tokens`);
      currentChunk = [];
      currentTokenCount = 0;
    }
    currentChunk.push(example);
    currentTokenCount += tokenCount;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
    console.log(`Final chunk created with ${currentChunk.length} examples and approximately ${currentTokenCount} tokens`);
  }

  console.log(`Splitting completed. Created ${chunks.length} chunks.`);
  return chunks;
}

// Function to export data to JSONL files
function exportDataToJSONL(data: ChatCompletionCreateParams[][]): string[] {
  const filePaths: string[] = [];

  for (let i = 0; i < data.length; i++) {
    const chunk = data[i];
    const filePath = path.join(tmpdir(), `fine_tuning_data_${i + 1}.jsonl`);
    
    const jsonlContent = chunk.map(example => JSON.stringify(example)).join('\n');
    fs.writeFileSync(filePath, jsonlContent);
    
    filePaths.push(filePath);
  }

  return filePaths;
}

// Main function to handle the /fine command
async function handleFineCommand(): Promise<string[]> {
  try {
    console.log('Starting fine-tuning data preparation...');
    
    console.log('Preparing data...');
    const startPrepare = Date.now();
    const rawData = await prepareData();
    console.log(`Data preparation completed. Time taken: ${(Date.now() - startPrepare) / 1000} seconds. Records retrieved: ${rawData.length}`);
    
    console.log('Creating fine-tuning examples...');
    const startCreate = Date.now();
    const fineTuningData = rawData.map(createFineTuningExample);
    console.log(`Fine-tuning examples created. Time taken: ${(Date.now() - startCreate) / 1000} seconds. Examples created: ${fineTuningData.length}`);
    
    console.log('Splitting data into chunks...');
    const startSplit = Date.now();
    const dataChunks = splitDataIntoChunks(fineTuningData);
    console.log(`Data split into chunks. Time taken: ${(Date.now() - startSplit) / 1000} seconds. Number of chunks: ${dataChunks.length}`);
    
    console.log('Exporting data to JSONL files...');
    const startExport = Date.now();
    const filePaths = exportDataToJSONL(dataChunks);
    console.log(`Data export completed. Time taken: ${(Date.now() - startExport) / 1000} seconds. Files created: ${filePaths.length}`);
    
    console.log('Fine-tuning data preparation completed successfully.');
    return filePaths;
  } catch (error) {
    console.error('Error in handleFineCommand:', error);
    throw error;
  }
}

// Export the handleFineCommand function
export { handleFineCommand };

// For testing purposes
if (import.meta.url === fileURLToPath(import.meta.resolve('./finetune.ts'))) {
  handleFineCommand()
    .then(filePaths => {
      console.log('JSONL files created:');
      filePaths.forEach(path => console.log(path));
    })
    .catch(error => {
      console.error('Error:', error);
    });
}