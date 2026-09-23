"""Разбор документа на пункты и нормы.

Пункт — минимальная цитируемая единица. Его номер в исходном документе
служит якорем ссылки, поэтому номер никогда не генерируется моделью:
он считывается из текста вместе с символьными смещениями.
"""
import re
import hashlib
from dataclasses import dataclass, field

CLAUSE_RE = re.compile(r"^(\d+(?:\.\d+)*)\.\s+(.*)$")
REF_RE = re.compile(r"п(?:ункт\w*|п)?\.?\s*((?:\d+\.)+\d+)(?:\s*и\s*((?:\d+\.)+\d+))?")

# Решётка модальности: чем выше ранг, тем сильнее норма.
MODALITY = {
    "обязан": 5, "обязаны": 5,
    "должен": 4, "должна": 4, "должны": 4,
    "осуществляется": 3, "проводится": 3, "производится": 3, "формируется": 3,
    "может": 2, "могут": 2, "вправе": 2, "имеет право": 2, "имеют право": 2,
}
PROHIBITION_MARKERS = ("не имеют права", "не имеет права", "запрещ", "не вправе")
RIGHT_MARKERS = ("имеет право", "имеют право", "имеют следующие права")

# Подразделения распознаются по аббревиатуре или полному наименованию.
UNITS = {
    "ДИТААД": "DITAAD", "ДОА": "DOA", "ДНМ": "DNM", "ДККМ": "DKKM",
    "Главный аудитор": "CAE", "Работники БВА": "STAFF",
    "Директор направления внутреннего аудита": "DIR_IA_LINE",
    "Директоры департаментов": "DEPT_DIRS", "Общество": "COMPANY",
    "департамента контроля качества аудита и методологии": "DKKM",
    "департамента непрерывного мониторинга": "DNM",
}

STOP = set("""и в во на по с со к ко для о об при не а но также том числе иных иные иной
其 их его ее её этом этих том та те то тот как что чем чтобы или либо же бы ли из за
до от через над под между перед после в_т_ч рамках части целях случае соответствии
настоящего настоящим данным данного положения общества бва а_также""".split())


def stem(token: str) -> str:
    """Грубая нормализация под сопоставление. Не морфология — усечение основы."""
    t = token.lower().strip(".,;:()«»\"'-–—")
    return t[:5] if len(t) > 5 else t


def tokens(text: str) -> set:
    raw = re.findall(r"[а-яёa-z]+", text.lower())
    return {stem(t) for t in raw if t not in STOP and len(t) > 2}


def overlap(a: set, b: set) -> float:
    """Жаккар по усечённым основам."""
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


@dataclass
class Clause:
    doc_id: str
    number: str
    text: str
    span: tuple
    scope: str = ""          # владелец, унаследованный от заголовка раздела
    chapter: str = ""

    @property
    def cid(self) -> str:
        return f"{self.doc_id}:{self.number}"

    @property
    def tokens(self) -> set:
        return tokens(self.text)

    @property
    def modality(self) -> int:
        low = self.text.lower()
        head = self.scope.lower()
        for marker in PROHIBITION_MARKERS:
            if marker in low or marker in head:
                return 0
        # Заголовок «... а также имеет право:» перекрывает «обязан» из той же строки.
        if any(m in head for m in RIGHT_MARKERS):
            return 2
        for word, rank in MODALITY.items():
            if re.search(rf"\b{word}\b", low):
                return rank
        for word, rank in MODALITY.items():
            if re.search(rf"\b{word}\b", head):
                return rank
        return 3  # изъявительное наклонение = действующая норма

    @property
    def is_header(self) -> bool:
        """Заголовок раздела («5.1. Главный аудитор:») — не норма, а область действия."""
        return self.text.rstrip().endswith(":")

    @property
    def kind(self) -> str:
        if self.is_header:
            return "header"
        if self.modality == 0:
            return "prohibition"
        if self.scope and self.chapter in ("3", "5"):
            return "capability"
        return "obligation"

    @property
    def owner(self) -> str:
        """unit_id владельца, выведенный из заголовка раздела."""
        head = self.scope
        if not head:
            return ""
        for name, uid in UNITS.items():
            if name.lower() in head.lower():
                return uid
        return head.split(",")[0][:40]

    def refs(self):
        out = []
        for m in REF_RE.finditer(self.text):
            out.extend(g for g in m.groups() if g)
        return out

    def hash(self) -> str:
        return hashlib.sha1(self.text.encode()).hexdigest()[:12]


def parse_text(raw: str, doc_id: str = "unknown") -> list:
    """Текст → список пунктов. Заголовок раздела становится scope дочерних пунктов.

    Смещения считаются по переданной строке, поэтому вызывающий обязан
    использовать ту же строку как источник для контроля цитат.
    """
    for line in raw.splitlines():
        if line.startswith("# doc_id:"):
            doc_id = line.split(":", 1)[1].strip()
            break

    clauses, scope_by_prefix, offset = [], {}, 0
    for line in raw.splitlines(keepends=True):
        start, offset = offset, offset + len(line)
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = CLAUSE_RE.match(stripped)
        if not m:
            continue
        number, text = m.group(1), m.group(2).strip()
        parts = number.split(".")
        chapter = parts[0]

        # Заголовок раздела: «5.1. Главный аудитор:» — задаёт владельца для 5.1.x
        if text.endswith(":") and len(parts) == 2:
            scope_by_prefix[number] = text.rstrip(":").strip()

        scope = ""
        if len(parts) >= 3:
            scope = scope_by_prefix.get(".".join(parts[:2]), "")
        elif len(parts) == 2 and not text.endswith(":"):
            scope = scope_by_prefix.get(number, "")

        col = stripped.find(text)
        clauses.append(Clause(doc_id, number, text,
                              (start + col, start + col + len(text)),
                              scope, chapter))
    return clauses


def load(path: str):
    """Файл (.docx или .txt) → (пункты, текст, отчёт о надёжности якорей)."""
    from .ingest import read
    import os
    text, report = read(path)
    doc_id = os.path.splitext(os.path.basename(path))[0]
    return parse_text(text, doc_id), text, report


def parse(path: str) -> list:
    """Совместимость: только пункты."""
    return load(path)[0]


def index(clauses: list) -> dict:
    return {c.number: c for c in clauses}
