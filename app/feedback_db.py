"""
Feedback database for storing FP/FN examples from production.
Uses SQLite for simple, file-based storage.
"""
import sqlite3
import json
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any
from collections import defaultdict
import logging

logger = logging.getLogger(__name__)

DB_PATH = Path(__file__).parent.parent / "feedback.db"


class FeedbackDB:
    """Simple SQLite database for storing feedback."""
    
    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self._init_db()
    
    def _init_db(self):
        """Initialize database schema."""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        
        # Feedback table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                text TEXT NOT NULL,
                predicted_spam BOOLEAN NOT NULL,
                actual_spam BOOLEAN NOT NULL,
                error_type TEXT NOT NULL,  -- 'fp' or 'fn'
                spam_score REAL,
                confidence REAL,
                reasons TEXT,  -- JSON array of reasons
                matched_rules TEXT,  -- JSON array of matched rule names
                sender_id TEXT,
                message_id TEXT,
                lang TEXT,
                metadata TEXT  -- JSON object for additional data
            )
        """)
        
        # Rule statistics table (aggregated)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS rule_stats (
                rule_name TEXT PRIMARY KEY,
                total_matches INTEGER DEFAULT 0,
                false_positives INTEGER DEFAULT 0,
                false_negatives INTEGER DEFAULT 0,
                true_positives INTEGER DEFAULT 0,
                true_negatives INTEGER DEFAULT 0,
                last_updated TEXT
            )
        """)
        
        # Create indexes
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_error_type ON feedback(error_type)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_timestamp ON feedback(timestamp)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_rule_name ON rule_stats(rule_name)
        """)
        
        conn.commit()
        conn.close()
        logger.info(f"Feedback database initialized at {self.db_path}")
    
    def add_feedback(
        self,
        text: str,
        predicted_spam: bool,
        actual_spam: bool,
        spam_score: Optional[float] = None,
        confidence: Optional[float] = None,
        reasons: Optional[List[str]] = None,
        matched_rules: Optional[List[str]] = None,
        sender_id: Optional[str] = None,
        message_id: Optional[str] = None,
        lang: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> int:
        """Add feedback entry and update rule statistics."""
        error_type = "fp" if (predicted_spam and not actual_spam) else "fn"
        
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        
        timestamp = datetime.now(timezone.utc).isoformat()
        reasons_json = json.dumps(reasons or [])
        matched_rules_json = json.dumps(matched_rules or [])
        metadata_json = json.dumps(metadata or {})
        
        cursor.execute("""
            INSERT INTO feedback (
                timestamp, text, predicted_spam, actual_spam, error_type,
                spam_score, confidence, reasons, matched_rules,
                sender_id, message_id, lang, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            timestamp, text, predicted_spam, actual_spam, error_type,
            spam_score, confidence, reasons_json, matched_rules_json,
            sender_id, message_id, lang, metadata_json
        ))
        
        feedback_id = cursor.lastrowid
        
        # Update rule statistics
        if matched_rules:
            for rule_name in matched_rules:
                # Determine if this was TP, FP, TN, or FN for this rule
                if predicted_spam and actual_spam:
                    stat_type = "true_positives"
                elif predicted_spam and not actual_spam:
                    stat_type = "false_positives"
                elif not predicted_spam and not actual_spam:
                    stat_type = "true_negatives"
                else:
                    stat_type = "false_negatives"
                
                # Update or insert rule stats
                cursor.execute("""
                    INSERT INTO rule_stats (
                        rule_name, total_matches, false_positives,
                        false_negatives, true_positives, true_negatives, last_updated
                    ) VALUES (?, 0, 0, 0, 0, 0, ?)
                    ON CONFLICT(rule_name) DO UPDATE SET
                        total_matches = total_matches + 1,
                        false_positives = false_positives + ?,
                        false_negatives = false_negatives + ?,
                        true_positives = true_positives + ?,
                        true_negatives = true_negatives + ?,
                        last_updated = ?
                """, (
                    rule_name, timestamp,
                    1 if stat_type == "false_positives" else 0,
                    1 if stat_type == "false_negatives" else 0,
                    1 if stat_type == "true_positives" else 0,
                    1 if stat_type == "true_negatives" else 0,
                    timestamp
                ))
        
        conn.commit()
        conn.close()
        
        logger.info(f"Feedback added: {error_type.upper()} (ID: {feedback_id})")
        return feedback_id
    
    def get_feedback(
        self,
        error_type: Optional[str] = None,
        limit: int = 100,
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        """Get feedback entries."""
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        query = "SELECT * FROM feedback WHERE 1=1"
        params = []
        
        if error_type:
            query += " AND error_type = ?"
            params.append(error_type)
        
        query += " ORDER BY timestamp DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        
        cursor.execute(query, params)
        rows = cursor.fetchall()
        
        results = []
        for row in rows:
            results.append({
                "id": row["id"],
                "timestamp": row["timestamp"],
                "text": row["text"],
                "predicted_spam": bool(row["predicted_spam"]),
                "actual_spam": bool(row["actual_spam"]),
                "error_type": row["error_type"],
                "spam_score": row["spam_score"],
                "confidence": row["confidence"],
                "reasons": json.loads(row["reasons"] or "[]"),
                "matched_rules": json.loads(row["matched_rules"] or "[]"),
                "sender_id": row["sender_id"],
                "message_id": row["message_id"],
                "lang": row["lang"],
                "metadata": json.loads(row["metadata"] or "{}")
            })
        
        conn.close()
        return results
    
    def get_rule_stats(self) -> Dict[str, Dict[str, Any]]:
        """Get aggregated statistics per rule."""
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT 
                rule_name,
                total_matches,
                false_positives,
                false_negatives,
                true_positives,
                true_negatives,
                last_updated
            FROM rule_stats
            ORDER BY false_positives DESC, false_negatives DESC
        """)
        
        rows = cursor.fetchall()
        conn.close()
        
        stats = {}
        for row in rows:
            tp = row["true_positives"]
            fp = row["false_positives"]
            fn = row["false_negatives"]
            tn = row["true_negatives"]
            total = tp + fp + fn + tn
            
            precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
            recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
            f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0
            fpr = fp / (fp + tn) if (fp + tn) > 0 else 0.0
            
            stats[row["rule_name"]] = {
                "total_matches": row["total_matches"],
                "false_positives": fp,
                "false_negatives": fn,
                "true_positives": tp,
                "true_negatives": tn,
                "precision": round(precision, 4),
                "recall": round(recall, 4),
                "f1_score": round(f1, 4),
                "false_positive_rate": round(fpr, 4),
                "last_updated": row["last_updated"]
            }
        
        return stats
    
    def get_summary(self) -> Dict[str, Any]:
        """Get summary statistics."""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        
        cursor.execute("SELECT COUNT(*) FROM feedback WHERE error_type = 'fp'")
        fp_count = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(*) FROM feedback WHERE error_type = 'fn'")
        fn_count = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(*) FROM feedback")
        total_count = cursor.fetchone()[0]
        
        cursor.execute("SELECT COUNT(DISTINCT rule_name) FROM rule_stats")
        rules_count = cursor.fetchone()[0]
        
        conn.close()
        
        return {
            "total_feedback": total_count,
            "false_positives": fp_count,
            "false_negatives": fn_count,
            "unique_rules": rules_count
        }


# Global instance
feedback_db = FeedbackDB()

