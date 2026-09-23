"""Слой модели: разъём, а не зависимость.

Лексика провалилась ровно там, где смысл один, а формулировка разная
(см. BENCHMARK.md: девять пропусков из одиннадцати). Модель вызывается только
в этой полосе неопределённости, а не на каждой паре: дёшево, быстро и видно,
какой именно вклад она даёт.

Два требования, которые слой обязан сохранить:

* **воспроизводимость** — каждый вердикт кэшируется по хэшу пары, поэтому
  повторный прогон даёт тот же результат, а не «модель сегодня в настроении»;
* **прослеживаемость** — модель решает только «одно ли это по смыслу».
  Номера пунктов и цитаты она не формирует: они уже вырезаны из файла.

Включение:

    export ARTIFEX_AI=anthropic
    export ARTIFEX_AI_KEY=sk-...
    python3 webapp/server.py

Без переменных окружения работает лексический слой, и это штатный режим,
а не деградация.
"""
import hashlib
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

CACHE = Path(__file__).resolve().parent.parent / ".cache" / "ai.json"
BAND = (0.18, 0.45)     # полоса неопределённости: ниже — точно разное, выше — точно одно

PROMPT = (
    "Ты сверяешь функции подразделений в нормативных документах.\n"
    "Вопрос: описывают ли два пункта ОДНУ И ТУ ЖЕ функцию, пусть и разными словами?\n"
    "Разными считаются функции, отличающиеся предметом или уровнем "
    "(например, «контроль устранения» и «контроль КАЧЕСТВА устранения» — разные).\n\n"
    "А: {a}\n\nБ: {b}\n\n"
    'Ответь строго JSON: {{"same": true|false, "confidence": 0..1, "why": "одна фраза"}}'
)


class Provider:
    """Базовый разъём. Возвращает None, если не берётся судить."""
    name = "none"
    available = False

    def judge_same(self, a: str, b: str):
        return None


class NullProvider(Provider):
    pass


class HTTPProvider(Provider):
    """Anthropic или OpenAI через urllib: внешних пакетов не требуется."""

    def __init__(self, kind: str, key: str, model: str):
        self.name, self.key, self.model = kind, key, model
        self.available = bool(key)
        self._cache = self._load()

    def _load(self):
        try:
            return json.loads(CACHE.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _save(self):
        try:
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            CACHE.write_text(json.dumps(self._cache, ensure_ascii=False, indent=1),
                             encoding="utf-8")
        except Exception:
            pass

    def _request(self, prompt: str) -> str:
        if self.name == "anthropic":
            url = "https://api.anthropic.com/v1/messages"
            headers = {"x-api-key": self.key, "anthropic-version": "2023-06-01",
                       "content-type": "application/json"}
            payload = {"model": self.model, "max_tokens": 200,
                       "messages": [{"role": "user", "content": prompt}]}
        else:
            url = "https://api.openai.com/v1/chat/completions"
            headers = {"Authorization": f"Bearer {self.key}",
                       "content-type": "application/json"}
            payload = {"model": self.model, "max_tokens": 200,
                       "messages": [{"role": "user", "content": prompt}]}

        req = urllib.request.Request(url, json.dumps(payload).encode(),
                                     headers, method="POST")
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read())
        if self.name == "anthropic":
            return data["content"][0]["text"]
        return data["choices"][0]["message"]["content"]

    def judge_same(self, a: str, b: str):
        if not self.available:
            return None
        key = hashlib.sha1(f"{self.model}|{a}|{b}".encode()).hexdigest()[:16]
        if key in self._cache:
            return self._cache[key]
        try:
            raw = self._request(PROMPT.format(a=a[:900], b=b[:900]))
            start, end = raw.find("{"), raw.rfind("}")
            verdict = json.loads(raw[start:end + 1])
            out = {"same": bool(verdict.get("same")),
                   "confidence": float(verdict.get("confidence", 0.5)),
                   "why": str(verdict.get("why", ""))[:160]}
        except (urllib.error.URLError, KeyError, ValueError, TimeoutError) as exc:
            # Отказ модели не должен ронять прогон: лексический слой остаётся.
            out = {"same": False, "confidence": 0.0, "why": f"модель недоступна: {exc}"}
        self._cache[key] = out
        self._save()
        return out


_provider = None


def provider() -> Provider:
    global _provider
    if _provider is None:
        kind = os.environ.get("ARTIFEX_AI", "none").lower()
        key = os.environ.get("ARTIFEX_AI_KEY", "")
        default_model = ("claude-sonnet-5" if kind == "anthropic" else "gpt-4o-mini")
        model = os.environ.get("ARTIFEX_AI_MODEL", default_model)
        _provider = (HTTPProvider(kind, key, model)
                     if kind in ("anthropic", "openai") and key else NullProvider())
    return _provider


def status() -> dict:
    p = provider()
    return {"engine": "правила + модель" if p.available else "правила",
            "provider": p.name, "available": p.available,
            "model": getattr(p, "model", None), "band": list(BAND)}


def adjudicate(a: str, b: str, lexical: float):
    """Полоса неопределённости → вердикт модели. Вне полосы модель не тревожим."""
    if not (BAND[0] <= lexical < BAND[1]):
        return None
    return provider().judge_same(a, b)
