"""
BiasModel v2.5 — DEMO BACKEND (Gemini-only, no local model required)
All pipeline stages use Gemini API — instantly deployable on Render/Railway.
"""
import os
import re
import io
import csv
import json
import uuid
import asyncio
from typing import List
from dotenv import load_dotenv

from openai import AsyncOpenAI
from fastapi import FastAPI, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from ddgs import DDGS
import pdfplumber
from docx import Document
import chromadb
from chromadb.utils import embedding_functions

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
    raise RuntimeError("GEMINI_API_KEY is required. Set it in your .env or Render/Vercel env vars.")

gemini = AsyncOpenAI(
    api_key=GEMINI_API_KEY,
    base_url="https://generativelanguage.googleapis.com/v1beta/openai/"
)

PREDICTOR_MODEL  = "gemini-2.0-flash"        # Fast + cheap for prediction
AUDITOR_MODEL    = "gemini-2.0-flash"         # Fast + cheap for auditing
META_MODEL       = "gemini-2.0-flash"         # Fast + cheap for meta-audit
SUPREME_MODEL    = "gemini-2.5-flash"         # Best quality for final fallback

# ── ChromaDB Memory (CPU-based, disk-persistent) ──────────────────────────────
MEMORY_MAX = 300
chroma  = chromadb.PersistentClient(path="./agent_memory")
emb_fn  = embedding_functions.DefaultEmbeddingFunction()

predictor_mem = chroma.get_or_create_collection("predictor_mistakes",  embedding_function=emb_fn)
auditor_mem   = chroma.get_or_create_collection("auditor_misses",      embedding_function=emb_fn)
meta_mem      = chroma.get_or_create_collection("meta_logic_failures", embedding_function=emb_fn)
success_cache = chroma.get_or_create_collection("success_cache",       embedding_function=emb_fn)

# ── Memory helpers ────────────────────────────────────────────────────────────

def _trim(collection, max_size=MEMORY_MAX):
    try:
        count = collection.count()
        if count <= max_size:
            return
        all_data = collection.get(include=["metadatas"])
        ids_ts = [(i, m.get("ts", 0)) for i, m in zip(all_data["ids"], all_data["metadatas"])]
        ids_ts.sort(key=lambda x: x[1])
        collection.delete(ids=[i for i, _ in ids_ts[:count - max_size]])
    except Exception as e:
        print(f"Trim error: {e}")

def get_memory(collection, query, n=2):
    try:
        count = collection.count()
        if count == 0:
            return ""
        results = collection.query(query_texts=[query], n_results=min(n, count))
        if results["documents"] and results["documents"][0]:
            return "\n### PAST LESSONS:\n" + "\n".join(f"- {d}" for d in results["documents"][0]) + "\n"
    except Exception as e:
        print(f"Memory read error: {e}")
    return ""

def save_memory(collection, query, lesson):
    try:
        collection.add(
            documents=[lesson],
            ids=[str(uuid.uuid4())],
            metadatas=[{"context": query[:100], "ts": asyncio.get_event_loop().time()}]
        )
        _trim(collection)
    except Exception as e:
        print(f"Memory write error: {e}")

def check_cache(text):
    try:
        if success_cache.count() == 0:
            return None
        r = success_cache.query(query_texts=[text], n_results=1)
        if r["distances"] and r["distances"][0] and r["distances"][0][0] < 0.05:
            return r["metadatas"][0][0].get("output")
    except Exception:
        pass
    return None

def save_cache(text, output):
    try:
        success_cache.add(
            documents=[text],
            ids=[str(uuid.uuid4())],
            metadatas=[{"output": output[:2000], "ts": asyncio.get_event_loop().time()}]
        )
        _trim(success_cache)
    except Exception:
        pass

# ── LLM call ──────────────────────────────────────────────────────────────────

async def call_gemini(model, system, user, temperature=0.3):
    try:
        resp = await gemini.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=temperature
        )
        return resp.choices[0].message.content, ""
    except Exception as e:
        return None, str(e)

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
    cached = await asyncio.to_thread(check_cache, input_data)
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
        mem = await asyncio.to_thread(get_memory, predictor_mem, input_data)
        sys_p = f"{system_prompt or f'Expert {task_type} assistant.'}\nCriteria: {criteria}\n{mem}"
        raw_out, err = await call_gemini(PREDICTOR_MODEL, sys_p,
            f"Input: {input_data[:15000]}\nContext: {rag[:2000]}\nGenerate neutral, objective response.")
        if not raw_out:
            yield {"event": "error", "data": f"Predictor failed: {err}"}
            return
        yield {"event": "predictor_end", "data": {"output": raw_out, "thoughts": ""}}

        # 2. Local Auditor
        yield {"event": "audit_start", "data": "Auditor checking for bias..."}
        aud_mem = await asyncio.to_thread(get_memory, auditor_mem, raw_out)
        a_sys = (
            f"Fairness Auditor. Only flag EXPLICIT bias. {aud_mem}\n"
            "Respond ONLY JSON: {\"is_biased\": bool, \"reason\": str, \"score\": int}"
        )
        a_raw, _ = await call_gemini(AUDITOR_MODEL, a_sys, f"Audit ({sensitive_attrs}):\n{raw_out}")
        a_data = clean_json(a_raw) or {"is_biased": False, "reason": "Parse error", "score": 0}
        yield {"event": "audit_end", "data": {**a_data, "source": "Gemini Flash", "thoughts": ""}}

        if a_data.get("is_biased"):
            await asyncio.to_thread(save_memory, predictor_mem, input_data,
                f"Failed: {a_data.get('reason', 'bias')}")
            yield {"event": "penalty", "data": {"reason": a_data.get("reason", "bias detected")}}
            continue

        # 3. Meta-Auditor (skippable)
        if skip_meta_bool:
            yield {"event": "meta_skipped", "data": "Meta-Auditor skipped — Speed Mode."}
            await asyncio.to_thread(save_cache, input_data, raw_out)
            yield {"event": "final_result", "data": raw_out}
            return

        yield {"event": "meta_start", "data": "Meta-Auditor verifying..."}
        m_mem = await asyncio.to_thread(get_memory, meta_mem, a_raw)
        m_raw, _ = await call_gemini(META_MODEL,
            f"Meta-Auditor. {m_mem}\nRespond ONLY 'VALID' or 'INVALID'.",
            f"Review this audit:\n{a_raw}")
        is_valid = "VALID" in (m_raw or "").upper()
        yield {"event": "meta_end", "data": {"is_valid": is_valid, "thoughts": ""}}

        if is_valid:
            await asyncio.to_thread(save_cache, input_data, raw_out)
            yield {"event": "final_result", "data": raw_out}
            return
        else:
            await asyncio.to_thread(save_memory, meta_mem, a_raw,
                f"Invalidated: {a_data.get('reason', 'unknown')}")
            yield {"event": "penalty", "data": {"reason": "Meta-Auditor rejected audit"}}

    # Supreme fallback
    yield {"event": "status", "data": f"Invoking Supreme Auditor ({SUPREME_MODEL})..."}
    s_sys = f"Supreme Fairness Auditor. Respond ONLY JSON: {{\"is_biased\": bool, \"reason\": str, \"score\": int}}"
    s_raw, _ = await call_gemini(SUPREME_MODEL, s_sys,
        f"Audit for bias ({sensitive_attrs}) in {task_type}:\n{raw_out}", temperature=0.1)
    supreme = clean_json(s_raw) or {"is_biased": True, "reason": "Supreme audit parse error", "score": 10}

    if supreme.get("is_biased"):
        await asyncio.to_thread(save_memory, auditor_mem, raw_out,
            f"Missed: {supreme.get('reason', 'unknown')}")
        yield {"event": "audit_end",   "data": {**supreme, "source": "Supreme (Gemini 2.5)", "thoughts": ""}}
        yield {"event": "error",       "data": f"Blocked by Supreme Auditor: {supreme.get('reason')}"}
    else:
        yield {"event": "audit_end",   "data": {**supreme, "source": "Supreme (Gemini 2.5)", "thoughts": ""}}
        await asyncio.to_thread(save_cache, input_data, raw_out)
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
                ctx = f"Role: {role}\n{text}"
                out.append({"filename": f"{role or f'Record {i+1}'} — row {i+1}", "text": ctx})
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
                results.append({"filename": f.filename, "text": "[Unsupported]"})
        except Exception as e:
            results.append({"filename": f.filename, "text": f"[Error: {e}]"})
    return results

@app.get("/")
async def health():
    return {"status": "BiasModel v2.5 Demo API running", "models": {
        "predictor": PREDICTOR_MODEL, "auditor": AUDITOR_MODEL,
        "meta": META_MODEL, "supreme": SUPREME_MODEL
    }}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
