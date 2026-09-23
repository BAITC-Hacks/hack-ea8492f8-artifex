#!/usr/bin/env python3
"""Веб-интерфейс: загрузка комплектов «до»/«после» и просмотр заключения.

    python3 webapp/server.py            → http://127.0.0.1:8000

Зависимостей нет и сборки нет: страница отдаётся одним файлом, движок
вызывается напрямую. Требование «запуск одной командой» выполняется буквально.
"""
import argparse
import json
import tempfile
import time
import zipfile
import sys
import webbrowser
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from orgsolvency.core import parse_text                      # noqa: E402
from orgsolvency.ingest import read_docx, CLAUSE_RE          # noqa: E402
from orgsolvency.detect import run as detect                 # noqa: E402
from orgsolvency.verify import check                         # noqa: E402
from orgsolvency.units import compare as compare_units       # noqa: E402
from orgsolvency.summary import (summarize, enrich,          # noqa: E402
                                 by_consequence)
from orgsolvency.ai import status as ai_status               # noqa: E402

PAGE = ROOT / "webapp" / "index.html"


class UserError(Exception):
    """Ошибка, которую показывают пользователю дословно."""


def to_text(name: str, blob: bytes) -> str:
    """Файл → нормализованный текст. .docx читается без зависимостей."""
    if not blob:
        raise UserError(f"Файл «{name}» пуст.")
    if name.lower().endswith(".docx"):
        # Сервер многопоточный: общий временный файл ломал бы параллельные загрузки.
        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as fh:
            fh.write(blob)
            path = fh.name
        try:
            text, _ = read_docx(path)
        except zipfile.BadZipFile:
            raise UserError(
                f"Файл «{name}» не читается как .docx. Возможно, это .doc старого "
                f"формата или файл повреждён — пересохраните его в Word как .docx.")
        except KeyError:
            raise UserError(f"В файле «{name}» нет основного документа word/document.xml.")
        finally:
            Path(path).unlink(missing_ok=True)
        return text
    return blob.decode("utf-8", "replace")


def build(side_files, doc_id, title):
    """Комплект файлов одной стороны → один документ с общей нумерацией."""
    chunks = [f"# doc_id: {doc_id}"]
    for name, blob in side_files:
        chunks.append(f"# файл: {name}")
        chunks.append(to_text(name, blob))
    text = "\n".join(chunks)
    clauses = parse_text(text, doc_id)
    numbered = sum(1 for line in text.splitlines() if CLAUSE_RE.match(line))
    seen, collisions = set(), 0
    for c in clauses:
        if c.number in seen:
            collisions += 1
        seen.add(c.number)
    return {
        "doc_id": doc_id, "title": title, "text": text,
        "files": [n for n, _ in side_files],
        "clauses": len(clauses), "numbered": numbered,
        "collisions": collisions,
    }, clauses


def analyze(before_files, after_files):
    """Этапы замеряются по-настоящему: интерфейс показывает фактическое время,
    а не анимацию, изображающую работу."""
    timings = []

    def phase(name, fn):
        t0 = time.perf_counter()
        out = fn()
        timings.append({"name": name, "ms": round((time.perf_counter() - t0) * 1000)})
        return out

    bdoc, before = phase("Разбор пунктов «до»",
                         lambda: build(before_files, "before", "Редакция «до»"))
    adoc, after = phase("Разбор пунктов «после»",
                        lambda: build(after_files, "after", "Редакция «после»"))
    if not before or not after:
        raise ValueError("Не удалось выделить ни одного пронумерованного пункта. "
                         "Проверьте, что в документах есть нумерация вида «5.6.3.».")

    units = phase("Сопоставление подразделений",
                  lambda: compare_units(before, after))
    findings = phase("Сопоставление функций", lambda: detect(before, after))
    findings = units["findings"] + findings
    findings, rejected = phase(
        "Контроль дословности цитат",
        lambda: check(findings, {"before": bdoc["text"], "after": adoc["text"]}))
    findings = enrich(findings)
    titles = {"before": bdoc["title"], "after": adoc["title"]}
    identical = bdoc["text"].split("\n", 1)[-1] == adoc["text"].split("\n", 1)[-1]
    summary = phase("Сборка заключения",
                    lambda: summarize(findings, before, after, titles))
    summary["by_consequence"] = by_consequence(findings)
    if identical:
        summary["headline"] = ("Комплекты «до» и «после» совпадают — "
                               "изменений нет")
        summary["narrative"] = (
            ["Загружены одинаковые документы. Показанные отклонения найдены "
             "внутри одного документа: осиротевшие обязательства, коллизии "
             "с запретами и конфликты интересов существуют в нём независимо "
             "от реорганизации."]
            if findings else
            ["Загружены одинаковые документы, отклонений внутри документа "
             "не обнаружено."])
        summary["identical"] = True

    return {
        "summary": summary,
        "findings": findings,
        "documents": {"before": bdoc, "after": adoc},
        "rejected": len(rejected),
        "structure": units["structure"],
        "unit_counts": units["counts"],
        "engine": ai_status(),
        "timings": timings,
        "total_ms": sum(t["ms"] for t in timings),
    }


def demo():
    def load(path, doc_id):
        return [(Path(path).name, Path(path).read_bytes())]
    return analyze(load(ROOT / "corpus/rev8.txt", "before"),
                   load(ROOT / "corpus/rev9.txt", "after"))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send_json(self, value, status=200):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            body = PAGE.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/health":
            return self.send_json({"status": "ok", **ai_status()})
        if path == "/api/demo":
            try:
                return self.send_json(demo())
            except Exception as exc:                          # noqa: BLE001
                print(f"  [ошибка demo] {type(exc).__name__}: {exc}")
                return self.send_json(
                    {"error": "Контрольный комплект не читается: "
                              "проверьте каталог corpus/."}, 500)
        return self.send_json({"error": "Неизвестный адрес"}, 404)

    def do_POST(self):
        if urlparse(self.path).path != "/api/analyze":
            return self.send_json({"error": "Неизвестный адрес"}, 404)
        try:
            ctype = self.headers.get("Content-Type")
            if not ctype or "multipart/form-data" not in ctype:
                return self.send_json(
                    {"error": "Запрос должен быть multipart/form-data "
                              "с полями before и after."}, 400)
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0:
                return self.send_json({"error": "Пустой запрос: файлы не переданы."}, 400)
            raw = (b"Content-Type: " + ctype.encode()
                   + b"\r\nMIME-Version: 1.0\r\n\r\n" + self.rfile.read(length))
            msg = BytesParser(policy=default).parsebytes(raw)

            sides = {"before": [], "after": []}
            for part in msg.iter_parts():
                disp = part.get("Content-Disposition", "")
                field = part.get_param("name", header="Content-Disposition")
                name = part.get_filename() or "файл"
                if field in sides and "filename" in disp:
                    sides[field].append((name, part.get_payload(decode=True)))

            if not sides["before"] or not sides["after"]:
                return self.send_json(
                    {"error": "Нужен хотя бы один файл в каждом комплекте."}, 400)
            return self.send_json(analyze(sides["before"], sides["after"]))
        except (UserError, ValueError) as exc:
            return self.send_json({"error": str(exc)}, 400)
        except Exception as exc:                              # noqa: BLE001
            # Внутреннюю трассировку пользователю не показываем.
            print(f"  [ошибка] {type(exc).__name__}: {exc}")
            return self.send_json(
                {"error": "Не удалось разобрать документы. Проверьте, что это "
                          ".docx или текст с нумерацией пунктов."}, 500)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args()
    url = f"http://127.0.0.1:{args.port}"
    print(f"\n  Artifex · анализ организационных изменений\n  {url}\n")
    if not args.no_open:
        webbrowser.open(url)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
