from transformers import AutoTokenizer, AutoModelForSequenceClassification
import torch
from typing import Dict
from app.config import settings
import logging

logger = logging.getLogger(__name__)


class MLModel:
    def __init__(self):
        self.model = None
        self.tokenizer = None
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self._load_model()

    def _load_model(self):
        try:
            model_name = settings.model_name
            logger.info(f"Loading ML model: {model_name}")
            
            # Try to load with use_fast=False for SentencePiece tokenizers
            try:
                self.tokenizer = AutoTokenizer.from_pretrained(model_name, use_fast=False)
            except Exception as e:
                logger.warning(f"Failed to load tokenizer with use_fast=False: {e}")
                # Fallback to default loading
                self.tokenizer = AutoTokenizer.from_pretrained(model_name)
            
            self.model = AutoModelForSequenceClassification.from_pretrained(model_name)
            self.model.to(self.device)
            self.model.eval()
            logger.info(f"ML model loaded successfully on {self.device}")
        except Exception as e:
            logger.error(f"Error loading ML model: {e}")
            logger.warning("ML model not loaded. Using fallback mode (rules + LLM only)")
            self.model = None
            self.tokenizer = None

    def predict(self, text: str) -> Dict[str, float]:
        if not self.model or not self.tokenizer:
            return {"spam": 0.0, "confidence": 0.0}

        try:
            inputs = self.tokenizer(
                text,
                return_tensors="pt",
                truncation=True,
                max_length=512,
                padding=True,
            ).to(self.device)

            with torch.no_grad():
                outputs = self.model(**inputs)
                logits = outputs.logits

            if logits.shape[1] >= 2:
                probs = torch.softmax(logits, dim=-1).cpu().numpy()[0]
                toxicity = float(probs[1])
            else:
                probs = torch.sigmoid(logits).cpu().numpy()[0]
                toxicity = float(probs[0])

            spam_score = toxicity * 0.8
            return {"spam": spam_score, "confidence": min(toxicity, 0.95)}
        except Exception as e:
            logger.error(f"Error in ML prediction: {e}")
            return {"spam": 0.0, "confidence": 0.0}


ml_model = MLModel()

