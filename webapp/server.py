#!/usr/bin/env python3
"""Веб-интерфейс: загрузка комплектов «до»/«после» и просмотр заключения.

    python3 webapp/server.py            → http://127.0.0.1:8000

Зависимостей нет и сборки нет: страница отдаётся одним файлом, движок
вызывается напрямую. Требование «запуск одной командой» выполняется буквально.
"""
import argparse
import json
import tempfile
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
from orgsolvency.summary import summarize                    # noqa: E402
from orgsolvency.ai import status as ai_status               # noqa: E402

PAGE = ROOT / "webapp" / "index.html"


def to_text(name: str, blob: bytes) -> str:
    """Файл → нормализованный текст. .docx читается без зависимостей."""
    if name.lower().endswith(".docx"):
        # Сервер многопоточный: общий временный файл ломал бы параллельные загрузки.
        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as fh:
            fh.write(blob)
            path = fh.name
        try:
            text, _ = read_docx(path)
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
    bdoc, before = build(before_files, "before", "Редакция «до»")
    adoc, after = build(after_files, "after", "Редакция «после»")
    if not before or not after:
        raise ValueError("Не удалось выделить ни одного пронумерованного пункта. "
                         "Проверьте, что в документах есть нумерация вида «5.6.3.».")

    findings = detect(before, after)
    findings, rejected = check(findings, {"before": bdoc["text"],
                                          "after": adoc["text"]})
    titles = {"before": bdoc["title"], "after": adoc["title"]}
    return {
        "summary": summarize(findings, before, after, titles),
        "findings": findings,
        "documents": {"before": bdoc, "after": adoc},
        "rejected": len(rejected),
        "engine": ai_status(),
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
                return self.send_json({"error": str(exc)}, 500)
        return self.send_json({"error": "Неизвестный адрес"}, 404)

    def do_POST(self):
        if urlparse(self.path).path != "/api/analyze":
            return self.send_json({"error": "Неизвестный адрес"}, 404)
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = (b"Content-Type: " + self.headers["Content-Type"].encode()
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
        except Exception as exc:                              # noqa: BLE001
            return self.send_json({"error": str(exc)}, 500)


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
