#!/usr/bin/env python3
"""Текст → .docx без зависимостей: python3 tools/make_docx.py вход.txt выход.docx

Нужен для проверки боевого пути загрузки: судьи приносят Word, а не текст.
"""
import sys
import zipfile
from html import escape
from pathlib import Path

CT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

HEAD = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>"""
TAIL = "</w:body></w:document>"


def para(text: str, bold: bool = False) -> str:
    rpr = "<w:rPr><w:b/></w:rPr>" if bold else ""
    return (f'<w:p><w:r>{rpr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>')


def build(lines, path: str):
    body = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        body.append(para(stripped, bold=stripped.endswith(":")))
    xml = HEAD + "".join(body) + TAIL
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/document.xml", xml)
    return path


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    build(Path(src).read_text(encoding="utf-8").splitlines(), dst)
    print(f"  {dst}  ({Path(dst).stat().st_size} байт)")
