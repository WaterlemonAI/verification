"""Ejari AES-GCM envelope, domain-separated from the shared root key."""
import os
import secrets
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

MAGIC = b'EJA1'

def _key():
    value = os.getenv('EJARI_DATA_ROOT_KEY_HEX', '')
    if len(value) != 64:
        raise ValueError('ENCRYPTION_UNAVAILABLE')
    try:
        root = bytes.fromhex(value)
    except ValueError as error:
        raise ValueError('ENCRYPTION_UNAVAILABLE') from error
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=b'', info=b'KYCProbe-Ejari-v1').derive(root)

def encrypt(data):
    nonce = secrets.token_bytes(12)
    encrypted = AESGCM(_key()).encrypt(nonce, data, None)
    return MAGIC + nonce + encrypted[-16:] + encrypted[:-16]

def decrypt(data):
    if len(data) < 32 or data[:4] != MAGIC:
        raise ValueError('ENCRYPTION_REQUIRED')
    return AESGCM(_key()).decrypt(data[4:16], data[32:] + data[16:32], None)
