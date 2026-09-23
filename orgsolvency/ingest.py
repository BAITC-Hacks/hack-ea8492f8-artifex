"""Чтение реальных форматов без внешних зависимостей.

.docx — это zip, внутри word/document.xml. Разметка читается регулярными
выражениями, а не xml.etree: парсер expat в ряде сборок Python на macOS
подгружает несовместимую libexpat и падает на импорте. Требование «запуск
одной командой на чистой машине» дороже элегантности разбора.

Отдельно решается риск, ломающий прослеживаемость: часть пунктов в Word
пронумерована автоматически, и номера в тексте нет. Такой абзац нельзя
цитировать по номеру пункта — он помечается как ненадёжный якорь, а не
получает выдуманный номер.
"""
import html
import re
import zipfile

CLAUSE_RE = re.compile(r"^\s*(\d+(?:\.\d+)*)\.?\s")
PARA_RE = re.compile(rb"<w:p[ >].*?</w:p>|<w:p/>", re.S)
TEXT_RE = re.compile(rb"<w:t(?:\s[^>]*)?>(.*?)</w:t>", re.S)
TAG_RE = re.compile(rb"<[^>]+>")


def _para_text(chunk: bytes) -> str:
    parts = [m.group(1) for m in TEXT_RE.finditer(chunk)]
    raw = b"".join(TAG_RE.sub(b"", p) for p in parts)
    return html.unescape(raw.decode("utf-8", "replace")).strip()


def read_docx(path: str):
    """→ (текст, отчёт о надёжности якорей цитирования)."""
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml")

    lines, unreliable, total = [], [], 0
    for m in PARA_RE.finditer(xml):
        chunk = m.group(0)
        text = _para_text(chunk)
        if not text:
            continue
        total += 1
        if CLAUSE_RE.match(text):
            lines.append(text)
        elif b"<w:numPr" in chunk:
            # Номер существует только в разметке Word: цитировать по нему нельзя.
            unreliable.append(text[:80])
            lines.append(f"[?] {text}")
        else:
            lines.append(text)

    return "\n".join(lines), {
        "paragraphs": total,
        "numbered_literally": sum(1 for l in lines if CLAUSE_RE.match(l)),
        "autonumbered_unreliable": len(unreliable),
        "samples": unreliable[:5],
    }


def read(path: str):
    """Единая точка входа: .docx или размеченный plain text."""
    if path.lower().endswith(".docx"):
        return read_docx(path)
    text = open(path, encoding="utf-8").read()
    return text, {
        "paragraphs": len([l for l in text.splitlines() if l.strip()]),
        "numbered_literally": sum(1 for l in text.splitlines()
                                  if CLAUSE_RE.match(l)),
        "autonumbered_unreliable": 0, "samples": [],
    }
