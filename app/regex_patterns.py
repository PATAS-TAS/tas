import re
from typing import List, Tuple


class RegexPatterns:
    def __init__(self):
        self.patterns: List[Tuple[re.Pattern, str, float]] = [
            (re.compile(r"(?i)\b(?:https?://|www\.)[\w\-]+(\.[\w\-]+)+(?:/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?", re.IGNORECASE), "Contains URL", 0.35),
            (re.compile(r"(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})|(?:\+\d{1,3}[-.\s]?)?\d{1,4}[-.\s]?\d{1,4}[-.\s]?\d{1,9}", re.IGNORECASE), "Contains phone number", 0.35),
            (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b", re.IGNORECASE), "Contains email", 0.35),
            (re.compile(r"\b(?:0x[a-fA-F0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{39,59})\b", re.IGNORECASE), "Contains cryptocurrency wallet", 0.35),
            (re.compile(r"(?i)\b(?:click here|urgent|limited time|act now|free money|guaranteed|no risk|congratulations|winner|prize|claim now|click below|verify account|suspended|locked|expire|immediate action)\b", re.IGNORECASE), "Contains scam phrase", 0.35),
            (re.compile(r"(?i)\b(?:job|work|vacancy|employment|part[- ]?time|temporary|hiring|recruitment|заработок|работа|вакансия|подработка|удалённ|remote work|work from home|earn \$|make money|quick cash|набираю|на работу|команду|команда|дистанционн|онлайн.*работ|заработок|инвестиции|сотрудничество|оклад|зарплата|от\s+\d+\s*(?:руб|₽|р\.)|смены|график|ежедневная\s+оплата|грузчик|курьер|менеджер|сортировщик|уборщик)\b", re.IGNORECASE), "Job offer or work solicitation", 0.4),
            (re.compile(r"(?i)\b(?:куплю|продам|продаю|покупаю|обмен|обменяю|сдам|сниму|аренд|аренду|стоимость|цена|дешево|недорого|скидка|акция|распродажа|новый|б/у|б у|б/у|состояние|отдам|бесплатно|дёшево|дорого|выкуп|обмен|бартер|от\s+\d+|руб|₽|р\.|звоните|пишите|whatsapp|вайбер|телеграм|telegram)\b", re.IGNORECASE), "Commercial trade offer", 0.4),
            (re.compile(r"(?i)\b(?:авто|машина|автомобиль|купить авто|продать авто|автосалон|подержанн|новый авто|расчет|кредит|лизинг|обмен авто)\b", re.IGNORECASE), "Car sale offer", 0.4),
            (re.compile(r"(?i)\b(?:квартир|дом|дача|участок|недвижимост|продажа|покупка|аренда|снять|сдать|комнат|студи|апартамент)\b", re.IGNORECASE), "Real estate offer", 0.4),
            (re.compile(r"(?i)\b(?:sale|discount|promotion|limited time|special offer|акция|скидка|распродажа|предложение|специальное)\b", re.IGNORECASE), "Sale or promotion", 0.35),
            (re.compile(r"(?i)\b(?:ремонт|починка|repair|fix|устранение|настройка|обслуживание|service|услуги)\b", re.IGNORECASE), "Service offer", 0.35),
            (re.compile(r"(?i)\b(?:репетитор|обучение|tutoring|tutor|уроки|lessons|курсы|courses|подготовка)\b", re.IGNORECASE), "Tutoring or education service", 0.35),
            (re.compile(r"(?i)\b(?:уборка|клининг|cleaning|уборщик|cleaner|уборка.*помещен|cleaning.*service)\b", re.IGNORECASE), "Cleaning service", 0.35),
            (re.compile(r"(?:https?://|www\.|t\.me|bit\.ly).*(?:https?://|www\.|t\.me|bit\.ly)", re.IGNORECASE), "Multiple URLs detected", 0.4),
            (re.compile(r"[A-Z]{5,}"), "Excessive capitalization", 0.35),
            (re.compile(r"[!?.]{3,}"), "Excessive punctuation", 0.35),
            (re.compile(r"(.)\1{4,}"), "Repeated characters", 0.35),
            (re.compile(r"^(?:пиши|готов|интересно|write|dm|pm)\s*[!?]*\s*$", re.IGNORECASE | re.MULTILINE), "Short spam phrase", 0.5),
            (re.compile(r"^.{0,10}$", re.DOTALL), "Very short message (< 10 chars)", 0.5),
        ]

    def check(self, text: str) -> List[Tuple[str, float]]:
        results = []
        word_count = len(text.split())
        
        for pattern, reason, base_score in self.patterns:
            matches = pattern.findall(text)
            if matches:
                match_count = len(matches) if isinstance(matches, list) else 1
                score = min(base_score * match_count, 0.9)
                results.append((reason, score))
        
        if word_count < 5 and len(text) < 20:
            results.append(("Very few words", 0.5))
        
        # Boost score if multiple commercial patterns detected
        commercial_patterns = ["Commercial trade offer", "Car sale offer", "Real estate offer", 
                             "Job offer or work solicitation", "Service offer", "Tutoring or education service",
                             "Cleaning service"]
        commercial_count = sum(1 for reason, _ in results if reason in commercial_patterns)
        if commercial_count >= 2:
            results.append(("Multiple commercial indicators", 0.3))
        
        return results


regex_patterns = RegexPatterns()

