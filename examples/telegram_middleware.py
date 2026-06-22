"""
Telegram bot middleware example using TAS API.
Demonstrates how to integrate TAS spam detection into a Telegram bot.
"""
import asyncio
import logging
from typing import Optional
import httpx
from telegram import Update
from telegram.ext import Application, MessageHandler, filters, ContextTypes

# Configure logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# TAS API configuration
TAS_API_KEY = "YOUR_TAS_API_KEY"  # Set from environment variable
TAS_API_URL = "https://tas.fly.dev/v1/classify"
LLM_MODE = "managed"  # or "byo", "rules_only"


class TASMiddleware:
    """Middleware for TAS spam detection."""
    
    def __init__(self, api_key: str, api_url: str = TAS_API_URL, llm_mode: str = "managed"):
        self.api_key = api_key
        self.api_url = api_url
        self.llm_mode = llm_mode
        self.client = httpx.AsyncClient(timeout=5.0)
    
    async def check_spam(self, text: str, user_id: Optional[int] = None) -> dict:
        """
        Check if message is spam.
        
        Returns:
            dict with keys:
            - spam: bool
            - score: float
            - reasons: list
            - path: str ("rules" or "llm")
            - mode: str
        """
        headers = {
            "x-api-key": self.api_key,
            "Content-Type": "application/json"
        }
        
        if self.llm_mode != "managed":
            headers["X-LLM-Mode"] = self.llm_mode
        
        payload = {
            "text": text,
            "lang": "ru",  # Detect language or use user's language
            "sender_id": str(user_id) if user_id else None
        }
        
        try:
            response = await self.client.post(
                self.api_url,
                json=payload,
                headers=headers
            )
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"TAS API error: {e}")
            # Fallback: allow message through (fail open)
            return {
                "spam": False,
                "score": 0.0,
                "reasons": [],
                "path": "rules",
                "mode": "rules_only"
            }
    
    async def close(self):
        """Close HTTP client."""
        await self.client.aclose()


# Initialize TAS middleware
tas = TASMiddleware(
    api_key=TAS_API_KEY,
    llm_mode=LLM_MODE
)


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle incoming Telegram message with spam detection."""
    message = update.message
    
    if not message or not message.text:
        return
    
    text = message.text
    user_id = message.from_user.id if message.from_user else None
    
    # Check for spam
    result = await tas.check_spam(text, user_id)
    
    if result.get("spam", False):
        score = result.get("score", 0.0)
        reasons = result.get("reasons", [])
        path = result.get("path", "rules")
        mode = result.get("mode", "managed")
        
        logger.warning(
            f"Spam detected: user={user_id}, score={score:.2f}, "
            f"path={path}, mode={mode}, reasons={[r.get('code') for r in reasons]}"
        )
        
        # Delete spam message
        try:
            await message.delete()
            logger.info(f"Deleted spam message from user {user_id}")
        except Exception as e:
            logger.error(f"Failed to delete message: {e}")
        
        # Optionally notify user
        warning_text = "⚠️ Ваше сообщение было удалено как спам."
        if score > 0.8:
            warning_text += " Повторные нарушения могут привести к блокировке."
        
        await message.reply_text(warning_text)
        
        return
    
    # Message is safe - process normally
    logger.info(f"Safe message from user {user_id}: {text[:50]}...")
    
    # Your bot logic here
    # For example, echo the message
    await message.reply_text(f"Вы написали: {text}")


async def post_init(app: Application) -> None:
    """Post-initialization hook."""
    logger.info("Bot started with TAS spam detection")


async def post_shutdown(app: Application) -> None:
    """Post-shutdown hook."""
    await tas.close()
    logger.info("Bot stopped, TAS middleware closed")


def main():
    """Main function to run the bot."""
    # Get Telegram bot token from environment
    import os
    bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not bot_token:
        raise ValueError("TELEGRAM_BOT_TOKEN environment variable not set")
    
    # Create application
    application = Application.builder().token(bot_token).build()
    
    # Add message handler
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    
    # Add post-init and post-shutdown hooks
    application.post_init = post_init
    application.post_shutdown = post_shutdown
    
    # Run bot
    logger.info("Starting bot...")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()


"""
Usage:

1. Install dependencies:
   pip install python-telegram-bot httpx

2. Set environment variables:
   export TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
   export TAS_API_KEY="your-tas-api-key"

3. Run bot:
   python telegram_middleware.py

4. Test with spam message:
   Send "Скидки -70% сегодня, пишите в тг @sale_best!" to your bot
   It should be deleted automatically.

Features:
- Automatic spam detection for all incoming messages
- Automatic message deletion for spam
- User warning notifications
- Logging of spam detection results
- Graceful fallback if TAS API is unavailable
- Support for different LLM modes (managed, byo, rules_only)

Integration tips:
- Add rate limiting per user
- Implement user blocking after multiple spam messages
- Add admin commands to whitelist/blacklist users
- Store spam detection results for analytics
"""

