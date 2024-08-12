  const gptPrompt = `Analyze multilingual Telegram messages for spam. Prioritize protecting users from scams, unsolicited commercial offers, and genuinely harmful content while allowing normal social interactions. Consider all context provided, but prioritize the actual content of the message. Output JSON only.

Key factors (importance order):
1. Message content and intent (any language)
2. User behavior and message pattern
3. Source relevance and group context
4. Links/media presence and nature
5. Complaint count and Telegram's spam probability (consider context)

Spam indicators (treat these more strictly):
- Any job offers
- Unsolicited commercial offers (e.g., crypto, investments, jobs, adult services)
- Scams, phishing, deceptive practices, get-rich-quick schemes
- Attempts to move conversations to private channels or external links for commercial purposes
- Excessive/shortened URLs unrelated to ongoing discussions
- Repetitive or bot-like behavior across multiple messages
- Unsolicited financial advice or investment opportunities
- Self-promotion for unrelated channels/groups
- Promises of unrealistic profits or returns
- Urgency in financial decisions or investments
- Mentioning specific usernames for financial services
- Explicit sexual content or services
- Invitations for private meetings or services without clear context
- Use of excessive emojis or symbols to bypass text filters
- Messages encouraging users to search for specific terms or usernames
- Promises of easy money or quick returns on investment
- Claims of working alongside studies or current job with minimal effort
- Requests to contact specific usernames for more information about earning opportunities
- Messages in languages different from the group's primary language, especially if promoting financial opportunities

Non-spam indicators:
- Simple greetings or introductions (e.g., "Hi", "Hello", "Good morning")
- Short, neutral messages without suspicious content
- Political discussions or opinions, even if controversial
- Use of strong language or profanity within context of discussion
- Group-relevant content (unless clearly violating community standards)
- Legitimate discussions on current events or social issues
- Standard bot commands/interactions

Weighting:
- Very High: Actual content of the message
- High: User behavior pattern (if known)
- Medium: Group context and complaint count
- Low: Telegram's spam probability for isolated messages

Ambiguous cases:
- For short messages or greetings, prioritize the actual content over group context
- Consider if the message could be a normal social interaction, even in groups with suspicious names
- For political or controversial content, prioritize free speech unless clearly harmful
- Err on the side of caution for explicit invitations or offers, but allow implicit or ambiguous content if not clearly spam

Consider the message content first, then the group context. Be cautious of commercial spam and explicit content, but allow for normal greetings and short social interactions, even in groups with suspicious names.
IMPORTANT: Simple greetings or short, neutral messages should not be classified as spam solely based on the group's name or context. Even in groups with suspicious names, allow for the possibility of normal social interactions unless there's clear evidence of spam behavior. However, be extra vigilant about messages promising easy money or quick returns, especially if they're in a language different from the group's primary language.
`;










_______________________________


  const gptPrompt = `# Telegram Spam Detection

Analyze the given message and classify it as spam (1) or not spam (0). Provide a detailed category and confidence score. Consider the Telegram context, where users can send text, media, and links in group chats or private messages in any language. Be very cautious about classifying messages as spam, especially short or emoji-only messages.

## 1 - Spam (only if very clear and obvious):
1.1. Commercial: Unsolicited ads, aggressive promotions
1.2. Scams: Clear phishing attempts, obvious fake giveaways
1.3. Malicious: Explicit mentions of malware or viruses
1.4. Adult: Explicit pornography, unsolicited adult services, private meetings/calls
1.5. Crypto/Financial: Unrealistic investment promises, obvious quick money schemes
1.6. Deceptive: Obvious impersonation, very misleading information
1.7. Unwanted: Excessive invites, clear chain messages
1.8. Any message with clear spam indicators
1.9 Asks to subscribe/follow/donate
1.10 Illegal Services: Offering fake documents, licenses, or other illegal services

## 0 - Not Spam (default for most messages):
0.1. Normal conversations: Any casual chat, greetings, emoji usage
0.2. Short messages: Single words, numbers, or emojis
0.3. Group-related content: Any message that could be relevant to a group
0.4. Opinions or reactions: Personal views, emotional responses
0.5. Questions or responses: Any form of inquiry or reply
0.6. Sharing of information: Links, news, or any shared content
0.7. Business or financial discussions: Unless clearly a scam
0.8. Insults, arguments, or disagreements: Unless very offensive or aggressive
0.9. Any message without clear spam indicators
0.10 Commands "/" to bots

Consider: Message intent, group context, and media content. A single complaint or the presence of emojis/short text does NOT automatically indicate spam. Err on the side of caution - if in doubt, classify as not spam.

Output: JSON with classification, category, and confidence score. Do not use markdown formatting or JSON code blocks in your response.`;

  // Формирование строки с результатами анализа изображений
  const visionAnalysis = visionResults.length > 0
    ? visionResults.map(vr => 
        `${vr.type} - Labels: ${vr.labels.join(', ')}, ` +
        `SafeSearch: ${JSON.stringify(vr.safeSearch)}, ` +
        `Text: ${vr.textAnnotations ? vr.textAnnotations[0]?.description : 'N/A'}`
      ).join(' | ')
    : 'Vision analysis unavailable';

  // Формирование промпта для пользователя с учетом всей доступной информации
  const userPrompt = `Analyze:
Message: "${message}"
Complaints: ${sysInfo.complaintCount}
Source: ${sysInfo.source}
Sender: ${sysInfo.sender}
Has Link: ${sysInfo.hasLink ? 'Yes' : 'No'}
Telegram Spam Probability: ${sysInfo.telegramSpamProbability}
Vision Analysis: ${visionAnalysis}

Respond with JSON:
{
  "classification": number (0 or 1),
  "category": string (e.g., "1.2" or "0.3"),
  "confidence": number (0-100)
}`;