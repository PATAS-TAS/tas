import dotenv from 'dotenv';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import OpenAI from 'openai';
import { ChatCompletionCreateParams } from 'openai/resources/chat/completions';

dotenv.config();

// Environment variables
const DATABASE_URL = process.env.DATABASE_URL!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

// Initialize PostgreSQL pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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

Respond only with 1 (spam) or 0 (not spam).`;

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

// Function to split data into chunks of approximately 1 million tokens
async function splitDataIntoChunks(data: ChatCompletionCreateParams[]): Promise<ChatCompletionCreateParams[][]> {
  const chunks: ChatCompletionCreateParams[][] = [];
  let currentChunk: ChatCompletionCreateParams[] = [];
  let currentTokenCount = 0;

  for (const example of data) {
    const tokenCount = await getTokenCount(example);
    if (currentTokenCount + tokenCount > 1000000) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokenCount = 0;
    }
    currentChunk.push(example);
    currentTokenCount += tokenCount;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// Function to get token count for a chat completion example
async function getTokenCount(example: ChatCompletionCreateParams): Promise<number> {
  try {
    const response = await openai.chat.completions.create({
      ...example,
      stream: false
    });
    
    if ('usage' in response && response.usage) {
      return response.usage.total_tokens;
    } else {
      console.warn('Unable to get token count from API response');
      return 0;
    }
  } catch (error) {
    console.error('Error getting token count:', error);
    return 0;
  }
}

// Function to export data to JSONL files
async function exportDataToJSONL(data: ChatCompletionCreateParams[][]): Promise<string[]> {
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
    console.log('Preparing data...');
    const rawData = await prepareData();
    
    console.log('Creating fine-tuning examples...');
    const fineTuningData = rawData.map(createFineTuningExample);
    
    console.log('Splitting data into chunks...');
    const dataChunks = await splitDataIntoChunks(fineTuningData);
    
    console.log('Exporting data to JSONL files...');
    const filePaths = await exportDataToJSONL(dataChunks);
    
    console.log('Data export completed.');
    return filePaths;
  } catch (error) {
    console.error('Error in handleFineCommand:', error);
    throw error;
  }
}

// Export the handleFineCommand function
export { handleFineCommand };

// For testing purposes
if (require.main === module) {
  handleFineCommand()
    .then(filePaths => {
      console.log('JSONL files created:');
      filePaths.forEach(path => console.log(path));
    })
    .catch(error => {
      console.error('Error:', error);
    });
}