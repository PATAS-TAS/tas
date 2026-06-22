import re
from typing import List, Tuple


class RegexPatterns:
    def __init__(self):
        # Pre-compile negative context patterns into a single regex for performance
        self.negative_context_pattern = re.compile(
            r"|".join([
                r"\b(?:я|мы|он|она|они)\s+(?:работаю|работаем|работает|работают)",
                r"\b(?:в\s+прошлом|в\s+прошлом\s+году|каждый\s+день|в\s+магазине)",
                r"\b(?:свой|старый|продал|продали|купил|купили)\b",
                r"\b(?:ищу|ищем|ищет)\s+(?:работу|работа)\b",
                r"\b(?:звоню|звони|звоним)\s+(?:маме|мама|другу|друзья)\b",
                r"\b(?:привет|hello|hi|hey|здравствуй|добрый\s+день|спасибо|thanks|thank\s+you|пожалуйста|please)\b",
                r"\b(?:как\s+дела|how\s+are\s+you|what's\s+up|что\s+нового)\b",
                r"\b(?:давай\s+встретимся|let's\s+meet|встреча|meeting)\b",
                r"\b(?:завтра|tomorrow|сегодня|today|вчера|yesterday)\b",
            ])
        )

        self.patterns: List[Tuple[re.Pattern, str, float]] = [
            (re.compile(r"(?i)\b(?:https?://|www\.)[\w\-]+(\.[\w\-]+)+(?:/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?", re.IGNORECASE), "Contains URL", 0.35),
            (re.compile(r"(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})|(?:\+\d{1,3}[-.\s]?)?\d{1,4}[-.\s]?\d{1,4}[-.\s]?\d{1,9}", re.IGNORECASE), "Contains phone number", 0.35),
            (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b", re.IGNORECASE), "Contains email", 0.35),
            (re.compile(r"\b(?:0x[a-fA-F0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{39,59})\b", re.IGNORECASE), "Contains cryptocurrency wallet", 0.35),
            (re.compile(r"(?i)\b(?:click here|urgent|limited time|act now|free money|guaranteed|no risk|congratulations|winner|prize|claim now|click below|verify account|suspended|locked|expire|immediate action)\b", re.IGNORECASE), "Contains scam phrase", 0.35),
            (re.compile(r"(?i)\b(?:job\s+offer|work\s+offer|vacancy|employment\s+offer|part[- ]?time\s+job|hiring|recruitment|заработок|работа\s+(?:на\s+дому|удалённ|онлайн|в\s+интернете)|вакансия|подработка|удалённ.*работ|remote\s+work|work\s+from\s+home|earn\s+\$|make\s+money|quick\s+cash|набираю|на\s+работу|команду|команда|дистанционн.*работ|заработок|инвестиции|сотрудничество|оклад|зарплата|от\s+\d+\s*(?:руб|₽|р\.)|смены|график|ежедневная\s+оплата|грузчик|курьер|менеджер|сортировщик|уборщик|требуются|срочно|нужны|набираем|набор|доход|заработка|личный\s+помощник|помощник|помощница)\b(?![^\s]*\b(?:программистом|в\s+компании|над\s+проектом|из\s+дома|в\s+Москве|ищу))\b", re.IGNORECASE), "Job offer or work solicitation", 0.4),
            (re.compile(r"(?i)\b(?:куплю|продам|продаю|покупаю|обмен|обменяю|сдам|сниму|аренд|аренду|стоимость|цена|дешево|недорого|скидка|акция|распродажа|новый|б/у|б у|б/у|состояние|отдам|бесплатно|дёшево|дорого|выкуп|обмен|бартер|от\s+\d+|руб|₽|р\.|звоните|пишите|whatsapp|вайбер|телеграм|telegram|срочно|быстро|немедленно|продается)\b(?![^\s]*\b(?:в\s+прошлом|в\s+прошлом\s+году|каждый\s+день|в\s+магазине|свой|старый))\b", re.IGNORECASE), "Commercial trade offer", 0.4),
            (re.compile(r"(?i)\b(?:авто|машина|автомобиль|купить авто|продать авто|автосалон|подержанн|новый авто|расчет|кредит|лизинг|обмен авто)\b", re.IGNORECASE), "Car sale offer", 0.4),
            (re.compile(r"(?i)\b(?:квартир|дом|дача|участок|недвижимост|продажа|покупка|аренда|снять|сдать|комнат|студи|апартамент)\b", re.IGNORECASE), "Real estate offer", 0.4),
            (re.compile(r"(?i)\b(?:sale|discount|promotion|limited time|special offer|акция|скидка|распродажа|предложение|специальное)\b", re.IGNORECASE), "Sale or promotion", 0.35),
            (re.compile(r"(?i)\b(?:ремонт|починка|repair|fix|устранение|настройка|обслуживание|service|услуги)\b", re.IGNORECASE), "Service offer", 0.35),
            (re.compile(r"(?i)\b(?:репетитор|обучение|tutoring|tutor|уроки|lessons|курсы|courses|подготовка)\b", re.IGNORECASE), "Tutoring or education service", 0.35),
            (re.compile(r"(?i)\b(?:уборка|клининг|cleaning|уборщик|cleaner|уборка.*помещен|cleaning.*service)\b", re.IGNORECASE), "Cleaning service", 0.35),
            (re.compile(r"(?:https?://|www\.|t\.me|bit\.ly).*(?:https?://|www\.|t\.me|bit\.ly)", re.IGNORECASE), "Multiple URLs detected", 0.4),
            (re.compile(r"^(?:https?://|www\.|t\.me|bit\.ly|tinyurl|t\.co|goo\.gl|short\.link|is\.gd|rebrand\.ly|ow\.ly|buff\.ly|adf\.ly|qr\.net|v\.gd|hst\.sh|clck\.ru|clk\.sh|v\.gd|shrtco\.de|shorte\.st|shorturl\.at|su\.pr|bc\.vc|t2m\.io|tiny\.cc|t\.ly|shorten\.asia|link\.short|shr\.tl|ht\.ly|t\.me/joinchat|t\.me/\+|t\.me/addlist|telegram\.me|tg\.me)[^\s]+$", re.IGNORECASE | re.MULTILINE), "URL-only message", 0.55),
            (re.compile(r"(?i)(?:https?://)?(?:bit\.ly|t\.me|tinyurl\.com|t\.co|goo\.gl|short\.link|is\.gd|rebrand\.ly|ow\.ly|buff\.ly|adf\.ly|qr\.net|v\.gd|hst\.sh|clck\.ru|clk\.sh|v\.gd|shrtco\.de|shorte\.st|shorturl\.at|su\.pr|bc\.vc|t2m\.io|tiny\.cc|t\.ly|shorten\.asia|link\.short|shr\.tl|ht\.ly)\b", re.IGNORECASE), "Short URL domain", 0.4),
            (re.compile(r"(?i)\b(?:crypto|bitcoin|btc|ethereum|eth|usdt|usdc|bnb|solana|sol|wallet|blockchain|defi|nft|airdrop|mining|staking|yield|farming|token|coin|exchange|trade|invest|profit|return|guaranteed|risk[- ]?free|passive income|earn daily|multiply|double|triple|10x|100x|1000x|pump|dump|hype|whale|hodl|btfd|moon|lambo|pump\s+and\s+dump|scam|rug\s+pull|ponzi|pyramid|scheme|referral|affiliate|bonus|reward|claim|verify|wallet|metamask|trust\s+wallet|connect|approve|sign|transaction|gas\s+fee|private\s+key|seed\s+phrase|mnemonic|крипто|биткоин|биток|эфир|кошел|блокчейн|нфт|аирдроп|майнинг|стейкинг|дефи|токен|монет|обмен|инвест|прибыль|доход|гарант|пассивн|помнож|умнож|удво|утро|пумп|дам|памп|скам|руг\s+пул|пирамид|реферал|бонус|наград|получи|подтвер|кошелек|подключ|одобр|подпис|транзакц|газ|приват|ключ|семен|мнемон|seed)\b", re.IGNORECASE), "Crypto/Web3 scam", 0.5),
            (re.compile(r"(?i)\b(?:referral|affiliate|invite|invitation|sign\s+up|register|join|bonus|reward|commission|earn|money|cash|free|gift|present|prize|win|winner|congratulations|claim|verify|activate|enroll|enrollment|партнер|реферал|приглаш|регистр|присоедин|бонус|наград|комисс|заработа|деньги|денег|бесплатн|подарок|приз|выигра|победи|поздравл|получи|подтвер|актив|запис)\b", re.IGNORECASE), "Referral/affiliate scheme", 0.45),
            (re.compile(r"(?i)\b(?:sex|sexual|porn|pornography|xxx|nsfw|adult|18\+|nude|naked|nudity|erotic|erotica|escort|prostitute|hooker|whore|slut|bitch|ass|pussy|dick|cock|penis|vagina|breast|boob|tits|fuck|suck|blowjob|oral|anal|bdsm|fetish|kink|orgasm|cum|sperm|masturbat|masturbation|hardcore|softcore|pornhub|xvideos|xnxx|pornstar|sexy|hot|horny|aroused|lust|desire|wet|dirty|filthy|pervert|perverted|explicit|intimate|intimacy|sexting|cam|webcam|camgirl|camboy|onlyfans|fansly|justforfans|sex|sexuelle|porno|xxx|adulte|18\+|nu|nudit|érotique|érotisme|escorte|prostitu|pute|salope|bite|queue|pénis|vagin|sein|seins|tétons|baise|sucer|pipe|oral|anal|bdsm|fétich|kink|orgasme|jouir|sperme|masturb|masturbation|hardcore|pornstar|sexy|chaud|excita|excité|désir|désiré|humide|sale|pervers|explicite|intime|sexting|cam|webcam|sexo|sexual|porno|xxx|adulto|18\+|desnud|desnudo|nudidad|erótico|erotismo|escort|prostitut|puta|zorra|perra|culo|coño|polla|pene|vagina|pecho|teta|tetas|follar|chupar|mamada|oral|anal|bdsm|fetiche|orgasmo|correrse|semen|masturb|masturbación|hardcore|pornstar|sexy|caliente|excitado|deseo|mojado|sucio|pervertido|explícito|íntimo|sexting|cam|webcam|性|性爱|性交|色情|色|黄|成人|18\+|裸体|裸|色情|色情|性服务|妓女|妓|婊|屁股|阴道|阴茎|鸡巴|乳房|奶|做爱|口交|口|肛|性虐|性癖|性高潮|射精|精液|手淫|自慰|硬核|色情明星|性感|热|兴奋|欲望|湿|脏|变态|露骨|亲密|性短信|摄像头|网络摄像头)\b", re.IGNORECASE), "NSFW/Adult content", 0.5),
            (re.compile(r"(?i)(?:[🔞💋🍑🍆💦🔥👅😈😏😘🥵🤤]|🍆|💦|🔥|👅|😈|😏|😘|🥵|🤤|🔞|💋|🍑)", re.IGNORECASE), "NSFW emoji", 0.4),
            (re.compile(r"(?i)\b(?:بيع|شراء|عرض|سعر|تخفيض|خصم|عروض|تسوق|تسوق|مستعمل|جديد|اتصال|واتساب|واتس|تليجرام|تليجرام|سريع|عاجل|فوري|أضف|انضم|اشترك|بيع\s+شراء|بيع\s+و\s+شراء|للبيع|للشراء|عرض\s+خاص|تخفيضات|خصومات|عروض\s+خاصة|تسوق\s+آمن|تسوق\s+أونلاين|تسوق\s+إلكتروني|تسوق\s+ذكي|تسوق\s+سريع|تسوق\s+مباشر|تسوق\s+مجاني|تسوق\s+بأفضل\s+سعر|تسوق\s+بأقل\s+سعر|تسوق\s+بخصم|تسوق\s+مع\s+تخفيض|تسوق\s+مع\s+خصم|تسوق\s+مع\s+عرض|تسوق\s+مع\s+عروض|تسوق\s+مع\s+عروض\s+خاصة|تسوق\s+مع\s+تخفيضات|تسوق\s+مع\s+خصومات|تسوق\s+مع\s+عروض\s+خاصة|تسوق\s+مع\s+تخفيضات\s+خاصة|تسوق\s+مع\s+خصومات\s+خاصة|تسوق\s+مع\s+عروض\s+مميزة|تسوق\s+مع\s+تخفيضات\s+مميزة|تسوق\s+مع\s+خصومات\s+مميزة)\b", re.IGNORECASE), "Arabic commercial spam", 0.4),
            (re.compile(r"(?i)\b(?:vendre|acheter|achat|vente|prix|promotion|réduction|remise|solde|offre|spécial|nouveau|occasion|d'occasion|neuf|contact|whatsapp|télégramme|télégram|rapide|urgent|immédiat|ajouter|rejoindre|s'inscrire|s'abonner|vendre\s+acheter|vendre\s+et\s+acheter|à\s+vendre|à\s+l'achat|offre\s+spéciale|promotions|réductions|remises|soldes|offres\s+spéciales|achat\s+sécurisé|achat\s+en\s+ligne|achat\s+électronique|achat\s+intelligent|achat\s+rapide|achat\s+direct|achat\s+gratuit|achat\s+au\s+meilleur\s+prix|achat\s+au\s+prix\s+le\s+plus\s+bas|achat\s+avec\s+remise|achat\s+avec\s+réduction|achat\s+avec\s+promotion|achat\s+avec\s+offre|achat\s+avec\s+offres\s+spéciales|achat\s+avec\s+promotions|achat\s+avec\s+réductions|achat\s+avec\s+remises|achat\s+avec\s+soldes|achat\s+avec\s+offres\s+spéciales|achat\s+avec\s+promotions\s+spéciales|achat\s+avec\s+réductions\s+spéciales|achat\s+avec\s+remises\s+spéciales|achat\s+avec\s+soldes\s+spéciales|achat\s+avec\s+offres\s+exclusives|achat\s+avec\s+promotions\s+exclusives|achat\s+avec\s+réductions\s+exclusives|achat\s+avec\s+remises\s+exclusives|achat\s+avec\s+soldes\s+exclusives)\b", re.IGNORECASE), "French commercial spam", 0.4),
            (re.compile(r"(?i)\b(?:vender|comprar|compra|venta|precio|promoción|reducción|descuento|rebaja|oferta|especial|nuevo|usado|segunda\s+mano|de\s+segunda\s+mano|nuevo|contacto|whatsapp|telegram|telegrama|rápido|urgente|inmediato|añadir|unirse|inscribirse|suscribirse|vender\s+comprar|vender\s+y\s+comprar|en\s+venta|a\s+la\s+compra|oferta\s+especial|promociones|reducciones|descuentos|rebajas|ofertas\s+especiales|compra\s+segura|compra\s+en\s+línea|compra\s+electrónica|compra\s+inteligente|compra\s+rápida|compra\s+directa|compra\s+gratis|compra\s+al\s+mejor\s+precio|compra\s+al\s+precio\s+más\s+bajo|compra\s+con\s+descuento|compra\s+con\s+reducción|compra\s+con\s+promoción|compra\s+con\s+oferta|compra\s+con\s+ofertas\s+especiales|compra\s+con\s+promociones|compra\s+con\s+reducciones|compra\s+con\s+descuentos|compra\s+con\s+rebajas|compra\s+con\s+ofertas\s+especiales|compra\s+con\s+promociones\s+especiales|compra\s+con\s+reducciones\s+especiales|compra\s+con\s+descuentos\s+especiales|compra\s+con\s+rebajas\s+especiales|compra\s+con\s+ofertas\s+exclusivas|compra\s+con\s+promociones\s+exclusivas|compra\s+con\s+reducciones\s+exclusivas|compra\s+con\s+descuentos\s+exclusivos|compra\s+con\s+rebajas\s+exclusivas)\b", re.IGNORECASE), "Spanish commercial spam", 0.4),
            (re.compile(r"(?i)\b(?:出售|购买|买卖|价格|促销|折扣|优惠|特价|新|旧|二手|联系|微信|whatsapp|电报|telegram|快速|紧急|立即|添加|加入|订阅)\b", re.IGNORECASE), "Chinese commercial spam", 0.4),
            (re.compile(r"(?i)\b(?:пp0дaм|кyпл|пpoдaю|пoкyпaю|oбмeн|пpeдлoж|цeн|дeшeв|нeдopoг|cкидк|aкция|pacпpoдaж|нoвый|б\/y|б\s+y|б\/y|coctoян|oтдaм|бecплaтн|дёшeв|дopoг|выкyп|oбмeн|бapтep|oт\s+\d+|pyб|₽|p\.|звoнит|пишит|whatsapp|вaйбep|тeлeгpaм|telegram|cpoчн|быcтpo|нeмeдлeнн|пpoдaeтcя)\b", re.IGNORECASE), "Russian transliteration spam", 0.45),
            (re.compile(r"[A-Z]{5,}"), "Excessive capitalization", 0.35),
            (re.compile(r"[!?.]{3,}"), "Excessive punctuation", 0.35),
            (re.compile(r"(.)\1{4,}"), "Repeated characters", 0.35),
            (re.compile(r"^(?:пиши|готов|интересно|write|dm|pm)\s*[!?]*\s*$", re.IGNORECASE | re.MULTILINE), "Short spam phrase", 0.5),
        ]

    def check(self, text: str) -> List[Tuple[str, float]]:
        results = []
        word_count = len(text.split())
        text_lower = text.lower()
        
        # Negative context checks (whitelist patterns)
        has_negative_context = bool(self.negative_context_pattern.search(text_lower))
        
        for pattern, reason, base_score in self.patterns:
            matches = pattern.findall(text)
            if matches:
                match_count = len(matches) if isinstance(matches, list) else 1
                score = min(base_score * match_count, 0.9)
                
                # Reduce score if negative context detected (legitimate messages)
                if has_negative_context:
                    if reason in ["Commercial trade offer", "Job offer or work solicitation", "Real estate offer"]:
                        score = score * 0.5
                    elif reason in ["Arabic commercial spam", "French commercial spam", "Spanish commercial spam", "Chinese commercial spam", "Russian transliteration spam"]:
                        score = score * 0.3
                    elif reason in ["Contains URL", "Short URL domain"] and word_count > 5:
                        score = score * 0.4
                
                results.append((reason, score))
        
        if word_count < 3 and len(text) < 15:
            results.append(("Very few words", 0.3))
        
        commercial_boosts = ["Commercial trade offer", "Car sale offer", "Real estate offer", 
                            "Job offer or work solicitation", "Service offer"]
        has_commercial = any(reason in commercial_boosts for reason, _ in results)
        if has_commercial and word_count <= 3 and not has_negative_context:
            results.append(("Short commercial message", 0.2))
        
        # Boost score if multiple commercial patterns detected
        commercial_patterns = ["Commercial trade offer", "Car sale offer", "Real estate offer", 
                             "Job offer or work solicitation", "Service offer", "Tutoring or education service",
                             "Cleaning service", "Arabic commercial spam", "French commercial spam", 
                             "Spanish commercial spam", "Chinese commercial spam", "Russian transliteration spam"]
        commercial_count = sum(1 for reason, _ in results if reason in commercial_patterns)
        if commercial_count >= 2:
            results.append(("Multiple commercial indicators", 0.35))
        
        # Boost if commercial pattern + phone/email/URL
        contact_patterns = ["Contains phone number", "Contains email", "Contains URL", "Short URL domain", "URL-only message"]
        has_contact = any(reason in contact_patterns for reason, _ in results)
        if commercial_count >= 1 and has_contact:
            results.append(("Commercial offer with contact info", 0.25))
        
        # Boost for URL-only + any other spam indicator
        high_risk_patterns = ["URL-only message", "Crypto/Web3 scam", "NSFW/Adult content", "Referral/affiliate scheme"]
        has_high_risk = any(reason in high_risk_patterns for reason, _ in results)
        if has_high_risk:
            results.append(("High-risk spam pattern", 0.2))
        
        # Boost for crypto + referral together (very suspicious)
        has_crypto = any(reason == "Crypto/Web3 scam" for reason, _ in results)
        has_referral = any(reason == "Referral/affiliate scheme" for reason, _ in results)
        if has_crypto and has_referral:
            results.append(("Crypto referral scam", 0.3))
        
        return results


regex_patterns = RegexPatterns()

