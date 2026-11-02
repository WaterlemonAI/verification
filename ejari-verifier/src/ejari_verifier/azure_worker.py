"""Tenant-isolated Azure Queue worker for the supplied DLD certificate flow."""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from azure.core import MatchConditions
from azure.core.exceptions import HttpResponseError, ResourceNotFoundError
from azure.data.tables import TableClient, UpdateMode
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
from azure.storage.blob import BlobServiceClient, ContentSettings
from azure.storage.queue import QueueClient

from .crypto import decrypt, encrypt
from .lookup import DLD_URL, verify_one
from .malware import scan_inputs


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def clients():
    blob_url = os.environ['EJARI_STORAGE_BLOB_URL'].rstrip('/')
    identity = ManagedIdentityCredential(client_id=os.environ['EJARI_WORKER_IDENTITY_CLIENT_ID'])
    container = BlobServiceClient(blob_url, credential=identity).get_container_client('ejari-private')
    queue = QueueClient(blob_url.replace('.blob.', '.queue.'), 'ejari-jobs', credential=identity)
    table = TableClient(blob_url.replace('.blob.', '.table.'), 'EjariJobs', credential=identity)
    vault = SecretClient(vault_url=os.environ['KEY_VAULT_URI'], credential=identity)
    return container, queue, table, vault


def settings(vault):
    try:
        config = json.loads(vault.get_secret('ejari-config').value)
    except ResourceNotFoundError:
        return {'enabled': False}
    if not config.get('enabled'):
        return {'enabled': False}
    return {
        'enabled': True,
        'model': str(config.get('ocr_model') or 'gpt-6-luna'),
        'detail': str(config.get('ocr_detail') or 'high'),
        'openai_key': vault.get_secret('ejari-openai-key').value,
        'capsolver_key': vault.get_secret('ejari-capsolver-key').value,
    }


def upload(container, name, data):
    container.upload_blob(name, encrypt(data), overwrite=True,
                          content_settings=ContentSettings(content_type='application/octet-stream',
                                                           cache_control='private, no-store'))


def decoded_message(content):
    try:
        return json.loads(base64.b64decode(content, validate=True))
    except (ValueError, TypeError):
        return json.loads(content)


def result_from_lookup(raw):
    status = str(raw.get('status') or 'error')
    if status == 'downloaded':
        comparison = raw.get('verification') or {}
        verified = comparison.get('status') == 'matching_fields'
        if raw.get('retrieved_ocr_check', {}).get('status') == 'differences_found':
            verified = False
        final_status = 'verified' if verified else 'review_required'
        reason = None if verified else 'FIELD_COMPARISON_REQUIRES_REVIEW'
    elif status == 'downloaded; OCR failed':
        final_status, reason = 'review_required', 'OCR_UNAVAILABLE'
    elif status.startswith('no record found'):
        final_status, reason = 'not_found', 'DLD_NO_RECORD'
    else:
        raise RuntimeError('DLD_LOOKUP_INCOMPLETE')
    return {
        'schemaVersion': 'ejari-v1', 'status': final_status,
        'decisionEligible': final_status == 'verified',
        'reasonCodes': [reason] if reason else [],
        'source': {'name': 'Dubai Land Department', 'url': DLD_URL, 'checkedAt': raw.get('checked_at_utc')},
        'inputType': raw.get('input_type'),
        'contractNumber': raw.get('contract_number'),
        'dewaNumber': raw.get('dewa_number'),
        'methodsAttempted': raw.get('methods_attempted') or [],
        'fields': raw.get('retrieved_ocr') or {},
        'comparison': raw.get('verification') or None,
        'ocr': {'model': 'ai7edd model', 'inputTokens': (raw.get('retrieved_ocr_usage') or {}).get('input_tokens'),
                'outputTokens': (raw.get('retrieved_ocr_usage') or {}).get('output_tokens')},
        'certificateAvailable': bool(raw.get('downloaded_file')),
    }


def validate_pdf(data):
    if not data.startswith(b'%PDF-') or len(data) > 10 * 1024 * 1024:
        raise ValueError('INVALID_PDF')
    scan_inputs([('application/pdf', data)])
    with tempfile.NamedTemporaryFile(suffix='.pdf') as handle:
        handle.write(data)
        handle.flush()
        info = subprocess.run(['pdfinfo', handle.name], capture_output=True, text=True, timeout=20, check=False)
    if info.returncode:
        raise ValueError('INVALID_PDF')
    found = re.search(r'^Pages:\s*(\d+)', info.stdout, re.M)
    if not found or not 1 <= int(found.group(1)) <= 10:
        raise ValueError('PDF_PAGE_LIMIT')


def process(payload, container, table, vault, config):
    partition = str(payload['partitionKey'])
    job_id = str(payload['jobId'])
    if not re.fullmatch(r'ejari_[0-9a-f-]{36}', job_id):
        raise ValueError('INVALID_JOB_ID')
    entity = table.get_entity(partition, f'job_{job_id}')
    if entity.get('status') in {'verified', 'review_required', 'not_found', 'could_not_complete'}:
        return 'done'
    lease_until = entity.get('leaseUntil')
    if entity.get('status') == 'processing' and lease_until and datetime.fromisoformat(lease_until) > datetime.now(timezone.utc):
        return 'busy'
    prefix = entity['blobPrefix']
    fields = json.loads(decrypt(container.download_blob(f'{prefix}/request.bin').readall()))
    try:
        table.update_entity({'PartitionKey': partition, 'RowKey': f'job_{job_id}', 'status': 'processing',
                             'leaseUntil': (datetime.now(timezone.utc) + timedelta(minutes=14)).isoformat()},
                            mode=UpdateMode.MERGE, etag=entity.metadata['etag'],
                            match_condition=MatchConditions.IfNotModified)
    except HttpResponseError as error:
        if error.status_code in {409, 412}:
            return 'busy'
        raise
    with tempfile.TemporaryDirectory(prefix='ejari-') as folder:
        directory = Path(folder)
        pdf = None
        if fields.get('input_pdf'):
            data = decrypt(container.download_blob(f'{prefix}/input.pdf.bin').readall())
            validate_pdf(data)
            pdf = directory / 'input.pdf'
            pdf.write_bytes(data)
        args = argparse.Namespace(contract_number=fields.get('contract_number'),
                                  dewa_number=fields.get('dewa_number'), municipality=None, sub_number=None,
                                  ocr_engine='openai', ocr_model=config['model'], ocr_detail=config['detail'],
                                  ocr_page=1, output_dir=directory, dry_run=False, dewa_only=False,
                                  openai_key=config['openai_key'])
        session = requests.Session()
        session.headers.update({'User-Agent': 'Mozilla/5.0', 'Accept': '*/*'})
        raw = verify_one(pdf, args, session, config['capsolver_key'])
        result = result_from_lookup(raw)
        certificate = raw.get('downloaded_file')
        if certificate:
            upload(container, f'{prefix}/certificate.pdf.bin', Path(certificate).read_bytes())
        upload(container, f'{prefix}/result.bin', json.dumps(result, ensure_ascii=False).encode())
        table.update_entity({'PartitionKey': partition, 'RowKey': f'job_{job_id}',
                             'status': result['status'], 'completedAt': utc_now(),
                             'reasonCode': result['reasonCodes'][0] if result['reasonCodes'] else '', 'leaseUntil': ''},
                            mode=UpdateMode.MERGE)
    return 'done'


def mark_failed(payload, container, table, reason):
    partition, job_id = str(payload['partitionKey']), str(payload['jobId'])
    entity = table.get_entity(partition, f'job_{job_id}')
    if entity.get('status') in {'verified', 'review_required', 'not_found', 'could_not_complete'}:
        return
    result = {'schemaVersion': 'ejari-v1', 'status': 'could_not_complete', 'decisionEligible': False,
              'reasonCodes': [reason], 'certificateAvailable': False}
    upload(container, f"{entity['blobPrefix']}/result.bin", json.dumps(result).encode())
    table.update_entity({'PartitionKey': partition, 'RowKey': f'job_{job_id}',
                         'status': 'could_not_complete', 'completedAt': utc_now(), 'reasonCode': reason,
                         'leaseUntil': ''},
                        mode=UpdateMode.MERGE)


def terminal_attempt_reason(error, attempt):
    code = str(error) if isinstance(error, ValueError) else ''
    if code in {'INVALID_PDF', 'PDF_PAGE_LIMIT', 'MALWARE_DETECTED'}:
        return code
    if attempt >= 3:
        return 'MALWARE_CHECK_FAILED' if code == 'MALWARE_CHECK_FAILED' else 'DLD_OR_OCR_UNAVAILABLE'
    return None


def run():
    container, queue, table, vault = clients()
    config = {'enabled': False}
    refreshed_at = 0.0
    while True:
        try:
            if time.monotonic() - refreshed_at >= 30:
                config = settings(vault)
                refreshed_at = time.monotonic()
            if not config['enabled']:
                time.sleep(15)
                continue
            received = list(queue.receive_messages(messages_per_page=1, visibility_timeout=900))
            if not received:
                time.sleep(2)
                continue
            message = received[0]
            try:
                payload = decoded_message(message.content)
                if payload.get('version') != 1 or not payload.get('partitionKey') or not payload.get('jobId'):
                    raise ValueError('INVALID_QUEUE_MESSAGE')
            except (ValueError, TypeError, AttributeError):
                print(json.dumps({'kind': 'ejari_invalid_queue_message'}), flush=True)
                queue.delete_message(message)
                continue
            try:
                started_at = time.monotonic()
                outcome = process(payload, container, table, vault, config)
                if outcome == 'busy':
                    queue.update_message(message, visibility_timeout=60)
                else:
                    queue.delete_message(message)
                    print(json.dumps({'kind': 'ejari_job_processed', 'elapsed_ms': round((time.monotonic() - started_at) * 1000)}), flush=True)
            except Exception as error:
                print(json.dumps({'kind': 'ejari_job_attempt_failed', 'reason': type(error).__name__,
                                  'attempt': message.dequeue_count}), flush=True)
                reason = terminal_attempt_reason(error, message.dequeue_count)
                if reason:
                    mark_failed(payload, container, table, reason)
                    queue.delete_message(message)
                else:
                    table.update_entity({'PartitionKey': payload['partitionKey'],
                                         'RowKey': f"job_{payload['jobId']}", 'status': 'queued',
                                         'leaseUntil': ''}, mode=UpdateMode.MERGE)
                    queue.update_message(message, visibility_timeout=min(300, 30 * message.dequeue_count))
        except Exception:
            time.sleep(10)


if __name__ == '__main__':
    run()
