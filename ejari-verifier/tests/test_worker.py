import base64
import os
import subprocess
import unittest
from datetime import datetime, timedelta, timezone

from ejari_verifier.azure_worker import process, result_from_lookup
from ejari_verifier.crypto import decrypt, encrypt
from ejari_verifier.lookup import EjariError, parse_dld_response
from ejari_verifier.purge import purge_records


class EjariWorkerTests(unittest.TestCase):
    def setUp(self):
        self.old_key = os.environ.get('EJARI_DATA_ROOT_KEY_HEX')
        os.environ['EJARI_DATA_ROOT_KEY_HEX'] = 'ab' * 32

    def tearDown(self):
        if self.old_key is None:
            os.environ.pop('EJARI_DATA_ROOT_KEY_HEX', None)
        else:
            os.environ['EJARI_DATA_ROOT_KEY_HEX'] = self.old_key

    def test_result_requires_field_evidence(self):
        raw = {'status': 'downloaded', 'downloaded_file': '/tmp/synthetic.pdf',
               'verification': {'status': 'matching_fields', 'compared_fields': 2},
               'retrieved_ocr_check': {'status': 'unavailable'}}
        self.assertEqual(result_from_lookup(raw)['status'], 'verified')
        raw['retrieved_ocr_check'] = {'status': 'differences_found'}
        self.assertEqual(result_from_lookup(raw)['status'], 'review_required')
        raw['verification'] = {'status': 'insufficient_fields'}
        self.assertEqual(result_from_lookup(raw)['status'], 'review_required')
        self.assertEqual(result_from_lookup({'status': 'downloaded; OCR failed'})['status'], 'review_required')
        self.assertEqual(result_from_lookup({'status': 'no record found'})['status'], 'not_found')
        with self.assertRaises(RuntimeError):
            result_from_lookup({'status': 'error'})

    def test_dld_null_is_distinct_from_captcha_failure(self):
        self.assertIsNone(parse_dld_response('bnVsbA=='))
        with self.assertRaises(EjariError):
            parse_dld_response('Invalid Captcha')

    def test_active_processing_lease_prevents_duplicate_provider_call(self):
        class Table:
            def get_entity(self, *_):
                return {'status': 'processing', 'leaseUntil':
                        (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()}
        payload = {'partitionKey': 'tenant-hash', 'jobId': 'ejari_11111111-1111-4111-8111-111111111111'}
        self.assertEqual(process(payload, None, Table(), None, None), 'busy')

    def test_encryption_is_compatible_with_node(self):
        original = b'{"contract_number":"0120221004004205"}'
        encrypted = encrypt(original)
        node = "import {decryptEjari,encryptEjari} from './lib/ejari-crypto.mjs';" \
               "const input=Buffer.from(process.argv[1],'base64');" \
               "process.stdout.write(encryptEjari(decryptEjari(input)).toString('base64'));"
        returned = subprocess.check_output(['node', '--input-type=module', '-e', node,
                                            base64.b64encode(encrypted).decode()], env=os.environ)
        self.assertEqual(decrypt(base64.b64decode(returned)), original)

    def test_expiry_scan_deletes_blobs_and_metadata_then_index(self):
        deleted = []
        row = {'PartitionKey': '202610', 'RowKey': '20261030000000000_ejari_id',
               'jobId': 'ejari_id', 'jobPartition': 'tenant-hash', 'idemKey': 'idem_hash',
               'blobPrefix': 'tenant-hash/ejari_id'}
        class Expiry:
            def query_entities(self, query, parameters):
                self.query = (query, parameters)
                return [row]
            def delete_entity(self, pk, rk):
                deleted.append(('expiry', pk, rk))
        class Jobs:
            def delete_entity(self, pk, rk):
                deleted.append(('job', pk, rk))
        class Blob:
            name = 'tenant-hash/ejari_id/result.bin'
        class Container:
            def list_blobs(self, name_starts_with):
                self.prefix = name_starts_with
                return [Blob()]
            def delete_blob(self, name):
                deleted.append(('blob', name))
        expiry, container = Expiry(), Container()
        count = purge_records(expiry, Jobs(), container, datetime(2026, 10, 31, tzinfo=timezone.utc), 1)
        self.assertEqual(count, 1)
        self.assertEqual(container.prefix, 'tenant-hash/ejari_id/')
        self.assertEqual([item[0] for item in deleted], ['blob', 'job', 'job', 'expiry'])


if __name__ == '__main__':
    unittest.main()
