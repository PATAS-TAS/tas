
import pytest
from app.pipeline import pipeline
from app.constants import NEGATIVE_CONTEXT_PHRASES

@pytest.mark.asyncio
async def test_calculate_rule_score_negative_context():
    """
    Verify that negative context phrases correctly dampen the score.
    This ensures the optimization (using generator and constant) didn't break logic.
    """
    # Text with commercial keywords AND negative context
    text = "Я ищу работу в магазине"
    
    # "Job offer" is a commercial keyword.
    # "ищу работу" and "в магазине" are negative context phrases.
    
    # Simulate rule results
    rule_results = [("Job offer or work solicitation", 0.4)]
    
    score, reasons = pipeline._calculate_rule_score(text, rule_results)
    
    # If negative context is detected, the commercial boost should NOT happen.
    # Logic in pipeline.py:
    # if not negative_context:
    #    if word_count <= 5: rule_score += 0.1
    
    # Here negative_context is True. So score should be just the rule score (0.4).
    # If negative_context was False (broken), score would be 0.4 + 0.1 = 0.5 (since word count is 5)
    
    assert score == 0.4
    
    # Now test WITHOUT negative context
    text_commercial = "Работа на дому срочно"
    rule_results_comm = [("Job offer or work solicitation", 0.4)]
    
    score_comm, _ = pipeline._calculate_rule_score(text_commercial, rule_results_comm)
    
    # Commercial boost should apply
    # word count is 4 <= 5 -> +0.1
    # "работа на дому" in text -> +0.1
    # Total boost +0.2?
    # Let's check logic:
    # if not negative_context:
    #   if word_count <= 5: score += 0.1
    #   if ("работа на дому"...) and word_count <= 8: score += 0.1
    
    # So 0.4 + 0.1 + 0.1 = 0.6
    
    assert score_comm >= 0.6

def test_negative_context_phrases_completeness():
    """Ensure essential phrases are present in the constant."""
    expected = [
        "в прошлом",
        "каждый день",
        "в магазине",
        "свой",
        "старый",
        "ищу работу",
        "работаю",
        "работаем"
    ]
    for phrase in expected:
        assert phrase in NEGATIVE_CONTEXT_PHRASES
