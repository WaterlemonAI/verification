"""Versioned bank-format mapping registry; never contains lending policy."""

import json
from functools import lru_cache
from pathlib import Path


PROFILE_DIR = Path(__file__).with_name("bank_profiles")


@lru_cache(maxsize=16)
def profile(name: str) -> dict:
    if not name or "/" in name or ".." in name:
        raise ValueError("INVALID_BANK_PROFILE")
    data = json.loads((PROFILE_DIR / f"{name}.json").read_text(encoding="utf-8"))
    needed = {"bankId", "formatVersion", "effectiveFrom", "locales", "productTypes", "dateFormat",
              "decimalSeparator", "thousandsSeparator", "balanceConvention"}
    if not needed.issubset(data):
        raise ValueError("INVALID_BANK_PROFILE")
    if any(key in data for key in ("riskThreshold", "dbrThreshold", "creditDecision")):
        raise ValueError("BANK_PROFILE_CONTAINS_LENDING_POLICY")
    return data
