"""Stable tenant-scoped identifiers without exposing account numbers."""

import hashlib
import hmac


def account_fingerprint(scope: str, bank: str, account: str) -> str:
    digest = hmac.new(scope.encode(), f"{bank.casefold()}\x1f{account}".encode(), hashlib.sha256).hexdigest()
    return f"sha256:{digest}"
