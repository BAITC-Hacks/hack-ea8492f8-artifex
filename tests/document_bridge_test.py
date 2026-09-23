import importlib.util
import io
from pathlib import Path
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("document_bridge", Path(__file__).resolve().parents[1] / "tools/document_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class Documents(unittest.TestCase):
    def test_utf8(self):
        self.assertEqual(bridge.extract("p.md", "1. Аудит".encode())["text"], "1. Аудит")

    def test_unknown_format(self):
        with self.assertRaises(ValueError):
            bridge.extract("code.exe", b"something")

    def test_empty(self):
        with self.assertRaises(ValueError):
            bridge.extract("empty.txt", b"")

    def test_word_loader_and_numbering_warning(self):
        blob = io.BytesIO()
        with zipfile.ZipFile(blob, "w") as archive:
            archive.writestr("word/document.xml", '<w:document><w:p><w:r><w:t>1. Finance &amp; Audit</w:t></w:r></w:p><w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Approve contracts</w:t></w:r></w:p></w:document>')
        result = bridge.extract("policy.docx", blob.getvalue())
        self.assertIn("Finance & Audit", result["text"])
        self.assertIn("[?] Approve contracts", result["text"])
        self.assertTrue(result["ingestionNotes"])

    def test_bad_zip(self):
        with self.assertRaises(zipfile.BadZipFile):
            bridge.extract("policy.docx", b"not a zip")

    @unittest.skipUnless(importlib.util.find_spec("pypdf"), "optional pypdf is not installed")
    def test_image_only_pdf_requires_ocr(self):
        from pypdf import PdfWriter
        writer = PdfWriter()
        writer.add_blank_page(width=400, height=600)
        blob = io.BytesIO()
        writer.write(blob)
        with self.assertRaisesRegex(ValueError, "OCR"):
            bridge.extract("scan.pdf", blob.getvalue())

    @unittest.skipUnless(importlib.util.find_spec("pypdf") and importlib.util.find_spec("reportlab"), "optional PDF test tools are not installed")
    def test_pdf_text(self):
        from reportlab.pdfgen.canvas import Canvas
        blob = io.BytesIO()
        canvas = Canvas(blob)
        canvas.drawString(50, 700, "1. Finance must approve contracts.")
        canvas.save()
        result = bridge.extract("policy.pdf", blob.getvalue())
        self.assertIn("[Page 1]", result["text"])
        self.assertIn("Finance must approve contracts", result["text"])

    @unittest.skipUnless(importlib.util.find_spec("openpyxl"), "optional openpyxl is not installed")
    def test_excel_keeps_cell_provenance_and_does_not_execute_formulas(self):
        from openpyxl import Workbook
        book = Workbook()
        book.active.title = "Responsibilities"
        book.active["A1"] = "Finance"
        book.active["B1"] = "Approve contracts"
        book.active["C1"] = "=1+1"
        blob = io.BytesIO()
        book.save(blob)
        result = bridge.extract("structure.xlsx", blob.getvalue())
        self.assertIn("[Sheet: Responsibilities]", result["text"])
        self.assertIn("B1: Approve contracts", result["text"])
        self.assertIn("C1: =1+1", result["text"])


if __name__ == "__main__":
    unittest.main()
