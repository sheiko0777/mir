"""Common report envelope for MIR services.

Every service writes one JSON document in this shape so the MIR server can
list, validate and age-check all services the same way. The Node validator in
apps/server/services.mjs enforces the same rules; test/fixtures holds shared
valid and invalid examples that both sides must agree on.

Rules that keep reports honest:
  * provenance says where the numbers came from;
  * staleAfterSeconds makes old data visibly stale instead of silently current;
  * executionEnabled must be False: these services never sign or send.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

SCHEMA_VERSION = 1
SERVICE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
STATUSES = ("ok", "incomplete", "source-unavailable")
MAX_STALE_SECONDS = 30 * 86_400


class Provenance(str, Enum):
    """Only CHAIN_OBSERVED and FORK_SIMULATED may support a claim about the chain."""
    CHAIN_OBSERVED = "CHAIN_OBSERVED"   # read from chain/explorer in this run
    PINNED_FIXTURE = "PINNED_FIXTURE"   # replayed from a saved capture
    FORK_SIMULATED = "FORK_SIMULATED"   # result of a stateful fork simulation
    ASSUMED_INPUT = "ASSUMED_INPUT"     # hand-typed or illustrative; never evidence


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_report(service: str, title: str, provenance: Provenance, stale_after_seconds: int,
                 data: Dict[str, Any], summary: Optional[Dict[str, Any]] = None,
                 caveats: Optional[List[str]] = None, status: str = "ok",
                 generated_at: Optional[str] = None) -> Dict[str, Any]:
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "service": service,
        "title": title,
        "status": status,
        "provenance": provenance.value,
        "generatedAt": generated_at or utc_now_iso(),
        "staleAfterSeconds": stale_after_seconds,
        "executionEnabled": False,
        "summary": summary or {},
        "caveats": caveats or [],
        "data": data,
    }
    errors = validate_report(report)
    if errors:
        raise ValueError("invalid service report: " + "; ".join(errors))
    return report


def validate_report(report: Any) -> List[str]:
    """Returns a list of problems; empty means valid."""
    if not isinstance(report, dict):
        return ["report is not an object"]
    errors: List[str] = []
    if report.get("schemaVersion") != SCHEMA_VERSION:
        errors.append("schemaVersion must be 1")
    service = report.get("service")
    if not isinstance(service, str) or not SERVICE_ID.match(service):
        errors.append("service must match [a-z0-9][a-z0-9-]{0,63}")
    title = report.get("title")
    if not isinstance(title, str) or not title.strip() or len(title) > 120:
        errors.append("title must be a non-empty string of at most 120 characters")
    if report.get("status") not in STATUSES:
        errors.append("status must be one of " + ", ".join(STATUSES))
    if report.get("provenance") not in [p.value for p in Provenance]:
        errors.append("provenance is not a known value")
    generated = report.get("generatedAt")
    if not isinstance(generated, str) or not TIMESTAMP.match(generated) or parse_timestamp(generated) is None:
        errors.append("generatedAt must be a UTC timestamp like 2026-11-15T12:00:00Z")
    stale = report.get("staleAfterSeconds")
    if isinstance(stale, bool) or not isinstance(stale, int) or not 0 < stale <= MAX_STALE_SECONDS:
        errors.append("staleAfterSeconds must be an integer between 1 and 2592000")
    if report.get("executionEnabled") is not False:
        errors.append("executionEnabled must be false")
    summary = report.get("summary")
    if not isinstance(summary, dict) or any(
            isinstance(v, (dict, list)) for v in summary.values()):
        errors.append("summary must be a flat object of scalar values")
    caveats = report.get("caveats")
    if not isinstance(caveats, list) or any(not isinstance(c, str) for c in caveats):
        errors.append("caveats must be a list of strings")
    if not isinstance(report.get("data"), dict):
        errors.append("data must be an object")
    return errors


def parse_timestamp(value: str) -> Optional[int]:
    try:
        return int(datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())
    except (TypeError, ValueError):
        return None


def is_stale(report: Dict[str, Any], now_ts: int) -> bool:
    generated = parse_timestamp(report["generatedAt"])
    return generated is None or now_ts - generated > report["staleAfterSeconds"] or generated > now_ts + 300


def write_report(report: Dict[str, Any], root: str, filename: str = "latest.json") -> str:
    """Atomically writes <root>/<service>/<filename>. Refuses invalid reports."""
    errors = validate_report(report)
    if errors:
        raise ValueError("invalid service report: " + "; ".join(errors))
    directory = os.path.join(root, report["service"])
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        os.replace(tmp, os.path.join(directory, filename))
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return os.path.join(directory, filename)
