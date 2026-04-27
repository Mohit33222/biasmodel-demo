"""
BiasModel v2.5 — DEMO BACKEND (Gemini-only, no local model required)
All pipeline stages use Gemini API — instantly deployable on Vercel / Render.
Memory: lightweight in-memory store (no ChromaDB needed for demo).
"""
import os
import re
import io
import csv
import json
import time
import uuid
import asyncio
from collections import deque
from typing import List
from dotenv import load_dotenv

from openai import AsyncOpenAI
from fastapi import FastAPI, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from ddgs import DDGS
import pdfplumber
from docx import Document

load_dotenv()
app = FastAPI(title="BiasModel v2.5 Demo")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── ALL AI via Gemini (no Jan AI / local model needed) ────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY is required. Set it in your .env or Vercel/Render env vars.")

gemini = AsyncOpenAI(
    api_key=GEMINI_API_KEY,
    base_url="https://generativelanguage.googleapis.com/v1beta/openai/"
)

PREDICTOR_MODEL = "gemini-2.0-flash-lite"   # fast + generous free tier
AUDITOR_MODEL   = "gemini-2.0-flash-lite"   # fast + generous free tier
META_MODEL      = "gemini-2.0-flash-lite"   # fast + generous free tier
SUPREME_MODEL   = "gemini-2.5-flash"        # best quality — only fires if all 3 retries fail

# ── Lightweight in-memory agent memory (replaces ChromaDB for demo) ───────────
MEMORY_MAX = 50

class MemoryStore:
    """Simple in-memory lesson store — keeps the most recent N entries."""
    def __init__(self, maxlen=MEMORY_MAX):
        self._store: deque = deque(maxlen=maxlen)

    def add(self, lesson: str):
        self._store.append({"text": lesson, "ts": time.time()})

    def recall(self, n=2) -> str:
        if not self._store:
            return ""
        recent = list(self._store)[-n:]
        return "\n### PAST LESSONS:\n" + "\n".join(f"- {e['text']}" for e in recent) + "\n"

class CacheStore:
    """Simple similarity cache — exact substring match for demo purposes."""
    def __init__(self, maxlen=MEMORY_MAX):
        self._store: deque = deque(maxlen=maxlen)

    def check(self, text: str):
        for entry in self._store:
            # Simple overlap: if 80%+ of words match consider it a hit
            words_q = set(text.lower().split())
            words_e = set(entry["key"].lower().split())
            if words_q and words_e:
                overlap = len(words_q & words_e) / max(len(words_q), len(words_e))
                if overlap > 0.85:
                    return entry["output"]
        return None

    def save(self, text: str, output: str):
        self._store.append({"key": text[:500], "output": output})

predictor_mem = MemoryStore()
auditor_mem   = MemoryStore()
meta_mem      = MemoryStore()
success_cache = CacheStore()

# ── LLM call ──────────────────────────────────────────────────────────────────

async def call_gemini(model, system, user, temperature=0.3, _retries=2):
    for attempt in range(_retries + 1):
        try:
            resp = await gemini.chat.completions.create(
                model=model,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                temperature=temperature
            )
            return resp.choices[0].message.content, ""
        except Exception as e:
            err = str(e)
            # Auto-retry on 429 rate limit — parse retry delay from error message
            if "429" in err and attempt < _retries:
                import re as _re
                delay_match = _re.search(r"retry.*?(\d+)", err, _re.IGNORECASE)
                delay = int(delay_match.group(1)) if delay_match else 15
                delay = min(delay, 60)  # cap at 60s
                print(f"Rate limited — waiting {delay}s then retrying ({attempt+1}/{_retries})...")
                await asyncio.sleep(delay)
                continue
            return None, err

def clean_json(text):
    if not text:
        return None
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    s, e = text.find("{"), text.rfind("}")
    if s != -1 and e != -1:
        try:
            return json.loads(text[s:e + 1])
        except Exception:
            return None
    return None

# ── RAG ───────────────────────────────────────────────────────────────────────

def ddg_search(query):
    try:
        with DDGS() as d:
            r = list(d.text(query, max_results=5))
            if r:
                return "\n".join(x.get("body", "") for x in r if x.get("body"))
    except Exception:
        pass
    return "No web context found."

# ── Core pipeline ─────────────────────────────────────────────────────────────

async def pipeline(
    input_data: str, task_type: str, sensitive_attrs: str,
    criteria: str, system_prompt: str = "",
    skip_meta: str = "false", use_search: str = "false"
):
    skip_meta_bool  = skip_meta.lower()  == "true"
    use_search_bool = use_search.lower() == "true"

    # Cache check
    cached = success_cache.check(input_data)
    if cached:
        yield {"event": "status",       "data": "Cache hit — returning stored result instantly."}
        yield {"event": "final_result", "data": cached}
        return

    # Conditional RAG
    rag = ""
    if use_search_bool:
        yield {"event": "status", "data": "Checking if web search is needed..."}
        eval_out, _ = await call_gemini(
            PREDICTOR_MODEL,
            "You decide if a web search is needed. Respond ONLY 'YES' or 'NO'.",
            f"Need external context for {task_type} bias evaluation of {sensitive_attrs}? Standard eval = NO."
        )
        if eval_out and "YES" in eval_out.upper():
            yield {"event": "status", "data": "Fetching DuckDuckGo context..."}
            rag = await asyncio.to_thread(ddg_search, f"Bias risks in {task_type} for {sensitive_attrs}")
            yield {"event": "rag_complete", "data": rag[:200] + "..."}
        else:
            yield {"event": "status", "data": "Web search skipped."}

    raw_out = ""
    for attempt in range(1, 4):
        yield {"event": "attempt_start", "data": {"attempt": attempt}}

        # 1. Predictor
        yield {"event": "predictor_start", "data": "Predictor (Gemini Flash) thinking..."}
        mem = predictor_mem.recall()
        sys_p = f"{system_prompt or f'Expert {task_type} assistant.'}\nCriteria: {criteria}\n{mem}"
        raw_out, err = await call_gemini(PREDICTOR_MODEL, sys_p,
            f"Input: {input_data[:15000]}\nContext: {rag[:2000]}\nGenerate neutral, objective response.")
        if not raw_out:
            yield {"event": "error", "data": f"Predictor failed: {err}"}
            return
        yield {"event": "predictor_end", "data": {"output": raw_out, "thoughts": ""}}

        # 2. Local Auditor
        yield {"event": "audit_start", "data": "Auditor checking for bias..."}
        aud_mem = auditor_mem.recall()
        a_sys = (
            f"Fairness Auditor. Only flag EXPLICIT bias. {aud_mem}\n"
            "Respond ONLY JSON: {\"is_biased\": bool, \"reason\": str, \"score\": int}"
        )
        a_raw, _ = await call_gemini(AUDITOR_MODEL, a_sys, f"Audit ({sensitive_attrs}):\n{raw_out}")
        a_data = clean_json(a_raw) or {"is_biased": False, "reason": "Parse error", "score": 0}
        yield {"event": "audit_end", "data": {**a_data, "source": "Gemini Flash", "thoughts": ""}}

        if a_data.get("is_biased"):
            predictor_mem.add(f"Failed: {a_data.get('reason', 'bias')}")
            yield {"event": "penalty", "data": {"reason": a_data.get("reason", "bias detected")}}
            continue

        # 3. Meta-Auditor (skippable)
        if skip_meta_bool:
            yield {"event": "meta_skipped", "data": "Meta-Auditor skipped — Speed Mode."}
            success_cache.save(input_data, raw_out)
            yield {"event": "final_result", "data": raw_out}
            return

        yield {"event": "meta_start", "data": "Meta-Auditor verifying..."}
        m_mem = meta_mem.recall()
        m_raw, _ = await call_gemini(META_MODEL,
            f"Meta-Auditor. {m_mem}\nRespond ONLY 'VALID' or 'INVALID'.",
            f"Review this audit:\n{a_raw}")
        is_valid = "VALID" in (m_raw or "").upper()
        yield {"event": "meta_end", "data": {"is_valid": is_valid, "thoughts": ""}}

        if is_valid:
            success_cache.save(input_data, raw_out)
            yield {"event": "final_result", "data": raw_out}
            return
        else:
            meta_mem.add(f"Invalidated: {a_data.get('reason', 'unknown')}")
            yield {"event": "penalty", "data": {"reason": "Meta-Auditor rejected audit"}}

    # Supreme fallback
    yield {"event": "status", "data": f"Invoking Supreme Auditor ({SUPREME_MODEL})..."}
    s_sys = "Supreme Fairness Auditor. Respond ONLY JSON: {\"is_biased\": bool, \"reason\": str, \"score\": int}"
    s_raw, _ = await call_gemini(SUPREME_MODEL, s_sys,
        f"Audit for bias ({sensitive_attrs}) in {task_type}:\n{raw_out}", temperature=0.1)
    supreme = clean_json(s_raw) or {"is_biased": True, "reason": "Supreme audit parse error", "score": 10}

    if supreme.get("is_biased"):
        auditor_mem.add(f"Missed: {supreme.get('reason', 'unknown')}")
        yield {"event": "audit_end",   "data": {**supreme, "source": "Supreme (Gemini 2.5)", "thoughts": ""}}
        yield {"event": "error",       "data": f"Blocked by Supreme Auditor: {supreme.get('reason')}"}
    else:
        yield {"event": "audit_end",   "data": {**supreme, "source": "Supreme (Gemini 2.5)", "thoughts": ""}}
        success_cache.save(input_data, raw_out)
        yield {"event": "final_result", "data": raw_out}

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/process")
async def process(
    request: Request,
    input_data: str, task_type: str, sensitive_attrs: str, criteria: str,
    system_prompt: str = "", skip_meta: str = "false", use_search: str = "false"
):
    async def gen():
        async for event in pipeline(input_data, task_type, sensitive_attrs,
                                    criteria, system_prompt, skip_meta, use_search):
            if await request.is_disconnected():
                break
            yield json.dumps(event)
    return EventSourceResponse(gen())

def parse_tsv(raw, filename):
    try:
        reader = csv.DictReader(io.StringIO(raw), delimiter="\t")
        rows = list(reader)
        if rows and "Resume" in rows[0]:
            out = []
            for i, row in enumerate(rows):
                text = row.get("Resume", "").strip()
                if not text:
                    continue
                role = row.get("Role", "").strip()
                out.append({"filename": f"{role or f'Record {i+1}'} — row {i+1}", "text": f"Role: {role}\n{text}"})
            if out:
                return out
    except Exception:
        pass
    return []

@app.post("/extract-cvs")
async def extract_cvs(files: List[UploadFile] = File(...)):
    results = []
    for f in files:
        content = await f.read()
        fname = (f.filename or "").lower()
        try:
            if fname.endswith(".pdf"):
                with pdfplumber.open(io.BytesIO(content)) as pdf:
                    text = "\n".join(p.extract_text() or "" for p in pdf.pages).strip()
                results.append({"filename": f.filename, "text": text})
            elif fname.endswith(".docx"):
                doc = Document(io.BytesIO(content))
                text = "\n".join(p.text for p in doc.paragraphs if p.text.strip()).strip()
                results.append({"filename": f.filename, "text": text})
            elif fname.endswith((".txt", ".tsv", ".csv")):
                raw = content.decode("utf-8", errors="ignore").strip()
                rows = parse_tsv(raw, f.filename)
                results.extend(rows) if rows else results.append({"filename": f.filename, "text": raw})
            else:
                results.append({"filename": f.filename, "text": "[Unsupported format]"})
        except Exception as e:
            results.append({"filename": f.filename, "text": f"[Error: {e}]"})
    return results

@app.get("/")
async def health():
    return {"status": "BiasModel v2.5 Demo API — online", "models": {
        "predictor": PREDICTOR_MODEL, "auditor": AUDITOR_MODEL,
        "meta": META_MODEL, "supreme": SUPREME_MODEL
    }}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
