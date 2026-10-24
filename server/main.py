"""
H-OS "Company Brain" — backend per il Librarian, con integrazione LLM.

Avvio:
    pip install fastapi uvicorn httpx python-dotenv      # (+ litellm se LLM_PROVIDER=litellm)
    cp .env.example .env     # e compila la chiave
    uvicorn main:app --reload --port 8000

Ogni evento ricevuto su /api/ingest viene:
  1. inviato all'LLM configurato (prompt di sistema "Brain di H-OS") -> summary / agent_hint / recommended_action
  2. salvato in memory.jsonl insieme al risultato (campo "brain")
Se l'LLM non è configurato o fallisce (rete, timeout, JSON non valido, quota...) si usa una regola predefinita:
la richiesta NON fallisce mai a causa dell'LLM.
"""
import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:  # opzionale: carica server/.env se python-dotenv è installato
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

log = logging.getLogger("hos.brain")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

MEMORY_FILE = Path(__file__).parent / "memory.jsonl"

SYSTEM_PROMPT = (
    "Sei il Brain di H-OS, l'AI Operating System aziendale. "
    "Analizza l'evento appena registrato dal browser. Genera:\n"
    "1. Un breve riassunto esecutivo.\n"
    "2. Un'azione proattiva / suggerimento intelligente (agent_hint) rilevante per il ruolo dell'utente.\n"
    "Restituisci una risposta JSON con campi: 'summary', 'agent_hint', e 'recommended_action'."
)

app = FastAPI(title="H-OS Company Brain")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class IngestPayload(BaseModel):
    schema_version: str
    event_id: str
    timestamp: str
    source: str                       # meet | search | download | navigation
    user: Dict[str, Any]              # client_id, role
    consent: Optional[Dict[str, Any]] = None
    data: Dict[str, Any]


# --------------------------------------------------------------------------------------
# Configurazione LLM (letta a ogni chiamata: modificare .env + reload basta)
# --------------------------------------------------------------------------------------
def _env_bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    return default if v is None or v.strip() == "" else v.strip().lower() in ("1", "true", "yes", "on")


def llm_config() -> Dict[str, Any]:
    provider = os.getenv("LLM_PROVIDER", "openai").strip().lower()  # openai | anthropic | litellm
    default_model = {"openai": "gpt-4o-mini", "anthropic": "claude-sonnet-4-5", "litellm": "gpt-4o-mini"}.get(provider, "")
    key = os.getenv("LLM_API_KEY") or {
        "openai": os.getenv("OPENAI_API_KEY"),
        "anthropic": os.getenv("ANTHROPIC_API_KEY"),
    }.get(provider)
    base_url = (os.getenv("LLM_BASE_URL") or "").strip().rstrip("/")
    return {
        "enabled": _env_bool("LLM_ENABLED", True),
        "provider": provider,
        "model": os.getenv("LLM_MODEL") or default_model,
        "api_key": (key or "").strip(),
        "base_url": base_url,
        "timeout": float(os.getenv("LLM_TIMEOUT", "20")),
        "json_mode": _env_bool("LLM_JSON_MODE", True),
        "max_chars": int(os.getenv("LLM_MAX_INPUT_CHARS", "6000")),
        "max_tokens": int(os.getenv("LLM_MAX_TOKENS", "600")),
        "sources": {s.strip() for s in os.getenv("LLM_SOURCES", "meet,download,search,navigation").split(",") if s.strip()},
    }


# --------------------------------------------------------------------------------------
# Fallback a regole (ex agent_hint statico)
# --------------------------------------------------------------------------------------
def rule_based_hint(p: IngestPayload) -> Optional[str]:
    d, role = p.data, p.user.get("role", "")
    if p.source == "download":
        if d.get("category") == "spreadsheet":
            return f"Ho visto che hai scaricato '{d.get('filename')}': vuoi che lo analizzi e ne ricavi un riepilogo?"
        if d.get("category") == "document":
            return f"Indicizzo '{d.get('filename')}' nella memoria aziendale per il team {role}?"
    if p.source == "search" and d.get("keywords"):
        return f"Su '{', '.join(d['keywords'][:3])}' esistono già note interne: te le preparo?"
    if p.source == "meet" and d.get("event") == "participants_update" and d.get("changes"):
        nuovi = [c["name"] for c in d["changes"] if c.get("type") == "joined"]
        if nuovi:
            return f"{', '.join(nuovi)} è entrato nella riunione: lo aggiungo ai contatti della riunione?"
    if p.source == "meet" and d.get("event") == "meeting_ended":
        return "Riunione conclusa: genero verbale e action item e li assegno?"
    return None


def rule_based_summary(p: IngestPayload) -> str:
    d = p.data
    if p.source == "navigation":
        return f"Navigazione su {d.get('host', '?')}{d.get('path', '')} — {d.get('title', '')}".strip(" —")
    if p.source == "search":
        return f"Ricerca {d.get('engine', 'web')}: '{d.get('query', '')}'."
    if p.source == "download":
        return f"Download di '{d.get('filename', '?')}' ({d.get('category', 'file')})."
    if p.source == "meet":
        ev = d.get("event", "evento")
        if ev == "participants_update":
            n = d.get("participant_count", len(d.get("participants", [])))
            return f"Aggiornamento partecipanti nella riunione {d.get('meeting_code', '')}: {n} presenti."
        if ev in ("transcript_chunk", "meeting_ended"):
            return f"{ev} della riunione {d.get('meeting_code', '')} ({len(d.get('segments', []))} interventi)."
        return f"Evento Meet '{ev}' ({d.get('meeting_code', '')})."
    return f"Evento {p.source}."


def rule_based_brain(p: IngestPayload) -> Dict[str, Any]:
    hint = rule_based_hint(p)
    return {
        "summary": rule_based_summary(p),
        "agent_hint": hint,
        "recommended_action": hint,
        "brain_source": "fallback",
    }


# --------------------------------------------------------------------------------------
# Chiamata all'LLM
# --------------------------------------------------------------------------------------
def _user_message(p: IngestPayload, max_chars: int) -> str:
    event = {
        "source": p.source,
        "timestamp": p.timestamp,
        "user_role": p.user.get("role", "sconosciuto"),
        "data": p.data,
    }
    txt = json.dumps(event, ensure_ascii=False)
    if len(txt) > max_chars:
        txt = txt[:max_chars] + " …[troncato]"
    return "Evento registrato dal browser (rispondi in italiano, solo JSON):\n" + txt


def _post_json(url: str, headers: Dict[str, str], body: Dict[str, Any], timeout: float) -> Dict[str, Any]:
    import httpx

    r = httpx.post(url, headers=headers, json=body, timeout=timeout)
    r.raise_for_status()
    return r.json()


def _call_openai_compatible(cfg: Dict[str, Any], user_msg: str) -> str:
    # Funziona con OpenAI e con qualunque endpoint compatibile (Azure-compat, Ollama, vLLM, proxy litellm...)
    base = cfg["base_url"] or "https://api.openai.com/v1"
    body: Dict[str, Any] = {
        "model": cfg["model"],
        "temperature": 0.2,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user_msg}],
    }
    if cfg["json_mode"]:
        body["response_format"] = {"type": "json_object"}
    data = _post_json(f"{base}/chat/completions", {"Authorization": f"Bearer {cfg['api_key']}"}, body, cfg["timeout"])
    return data["choices"][0]["message"]["content"]


def _call_anthropic(cfg: Dict[str, Any], user_msg: str) -> str:
    base = cfg["base_url"] or "https://api.anthropic.com"
    body = {
        "model": cfg["model"],
        "max_tokens": cfg["max_tokens"],
        "temperature": 0.2,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_msg}],
    }
    headers = {"x-api-key": cfg["api_key"], "anthropic-version": "2023-06-01"}
    data = _post_json(f"{base}/v1/messages", headers, body, cfg["timeout"])
    return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")


def _call_litellm(cfg: Dict[str, Any], user_msg: str) -> str:
    import litellm  # type: ignore

    kwargs: Dict[str, Any] = {
        "model": cfg["model"],
        "temperature": 0.2,
        "timeout": cfg["timeout"],
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user_msg}],
    }
    if cfg["api_key"]:
        kwargs["api_key"] = cfg["api_key"]
    if cfg["base_url"]:
        kwargs["api_base"] = cfg["base_url"]
    resp = litellm.completion(**kwargs)
    return resp.choices[0].message.content


def _extract_json(text: str) -> Dict[str, Any]:
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I)  # code fence
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            raise ValueError("risposta LLM senza JSON")
        obj = json.loads(text[start : end + 1])
    if not isinstance(obj, dict):
        raise ValueError("JSON LLM non è un oggetto")
    return obj


def _clean(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip()
        return v or None
    if isinstance(v, (dict, list)):
        return v
    return str(v)


def llm_brain(p: IngestPayload, cfg: Dict[str, Any]) -> Dict[str, Any]:
    user_msg = _user_message(p, cfg["max_chars"])
    provider = cfg["provider"]
    if provider == "anthropic":
        raw = _call_anthropic(cfg, user_msg)
    elif provider == "litellm":
        raw = _call_litellm(cfg, user_msg)
    elif provider == "openai":
        raw = _call_openai_compatible(cfg, user_msg)
    else:
        raise ValueError(f"LLM_PROVIDER sconosciuto: {provider}")

    obj = _extract_json(raw)
    summary, hint, action = _clean(obj.get("summary")), _clean(obj.get("agent_hint")), _clean(obj.get("recommended_action"))
    if not summary and not hint:
        raise ValueError("JSON LLM privo di summary/agent_hint")
    rules = rule_based_brain(p)  # completa eventuali campi mancanti
    return {
        "summary": summary or rules["summary"],
        "agent_hint": hint or rules["agent_hint"],
        "recommended_action": action or hint or rules["recommended_action"],
        "brain_source": "llm",
        "model": f"{provider}:{cfg['model']}",
    }


_warned_no_key = False


def generate_brain(p: IngestPayload) -> Dict[str, Any]:
    """Non solleva mai eccezioni: in caso di problemi ricade sulle regole predefinite."""
    global _warned_no_key
    try:
        cfg = llm_config()
        if not cfg["enabled"] or p.source not in cfg["sources"]:
            return rule_based_brain(p)
        if not cfg["api_key"] and not (cfg["provider"] in ("openai", "litellm") and cfg["base_url"]):
            # (un endpoint locale compatibile, es. Ollama, può funzionare senza chiave)
            if not _warned_no_key:
                log.warning("Nessuna chiave LLM configurata: uso le regole predefinite (vedi .env.example).")
                _warned_no_key = True
            return rule_based_brain(p)
        return llm_brain(p, cfg)
    except Exception as exc:  # noqa: BLE001 — qualunque errore LLM deve degradare, non rompere /api/ingest
        log.warning("LLM non disponibile (%s: %s) — fallback a regole.", type(exc).__name__, str(exc)[:200])
        try:
            fb = rule_based_brain(p)
        except Exception:  # noqa: BLE001
            fb = {"summary": f"Evento {p.source}.", "agent_hint": None, "recommended_action": None, "brain_source": "fallback"}
        fb["llm_error"] = type(exc).__name__
        return fb


# --------------------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------------------
@app.get("/health")
def health():
    cfg = llm_config()
    return {
        "status": "ok",
        "time": datetime.now().isoformat(),
        "llm": {
            "enabled": cfg["enabled"],
            "provider": cfg["provider"],
            "model": cfg["model"],
            "has_key": bool(cfg["api_key"]),
            "base_url": cfg["base_url"] or None,
        },
    }


@app.post("/api/ingest")
def ingest(p: IngestPayload):
    record = p.model_dump()
    record["received_at"] = datetime.now().isoformat()

    brain = generate_brain(p)  # mai eccezioni
    record["brain"] = brain

    with MEMORY_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

    tag = "  [SIMULATO]" if p.data.get("simulated") else ""
    print(f"\n[{record['received_at']}] {p.source.upper()}  ruolo={p.user.get('role')}{tag}")
    print(json.dumps(p.data, indent=2, ensure_ascii=False)[:1200])
    print(f"   🧠 brain[{brain.get('brain_source')}]: {brain.get('summary')}")
    if brain.get("agent_hint"):
        print(f"   🤖 agente: {brain['agent_hint']}")

    return {
        "status": "stored",
        "event_id": p.event_id,
        "agent_hint": brain.get("agent_hint"),
        "summary": brain.get("summary"),
        "recommended_action": brain.get("recommended_action"),
        "brain_source": brain.get("brain_source"),
    }


@app.get("/api/memory")
def memory(limit: int = 50):
    if not MEMORY_FILE.exists():
        return []
    lines = MEMORY_FILE.read_text(encoding="utf-8").splitlines()[-limit:]
    return [json.loads(l) for l in lines]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)