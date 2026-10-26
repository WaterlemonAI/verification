"""AES-256-GCM envelope shared with the local Node API."""

import json
import os
import secrets
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


MAGIC = b"BSA1"


def _key() -> bytes:
    value = os.getenv("BSA_DATA_KEY_HEX", "")
    if len(value) != 64:
        raise ValueError("ENCRYPTION_UNAVAILABLE")
    try:
        return bytes.fromhex(value)
    except ValueError as error:
        raise ValueError("ENCRYPTION_UNAVAILABLE") from error


def encrypt(data: bytes) -> bytes:
    iv = secrets.token_bytes(12)
    ciphertext_and_tag = AESGCM(_key()).encrypt(iv, data, None)
    return MAGIC + iv + ciphertext_and_tag[-16:] + ciphertext_and_tag[:-16]


def decrypt(data: bytes) -> bytes:
    if len(data) < 32 or data[:4] != MAGIC:
        raise ValueError("ENCRYPTION_REQUIRED")
    return AESGCM(_key()).decrypt(data[4:16], data[32:] + data[16:32], None)


def encrypted_json(path: Path) -> dict:
    return json.loads(decrypt(path.read_bytes()))
