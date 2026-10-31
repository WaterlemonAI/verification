"""Delete expired Ejari blobs and metadata using a date-keyed recovery index."""
from __future__ import annotations

import os
from datetime import datetime, timezone

from azure.core.exceptions import ResourceNotFoundError
from azure.data.tables import TableClient
from azure.identity import ManagedIdentityCredential
from azure.storage.blob import BlobServiceClient


def months(start, end):
    year, month = start
    while (year, month) <= end:
        yield f'{year:04d}{month:02d}'
        month += 1
        if month == 13:
            year, month = year + 1, 1


def purge(limit=5000):
    url = os.environ['EJARI_STORAGE_BLOB_URL'].rstrip('/')
    identity = ManagedIdentityCredential(client_id=os.environ['EJARI_WORKER_IDENTITY_CLIENT_ID'])
    table_url = url.replace('.blob.', '.table.')
    expiry = TableClient(table_url, 'EjariExpiry', credential=identity)
    jobs = TableClient(table_url, 'EjariJobs', credential=identity)
    container = BlobServiceClient(url, credential=identity).get_container_client('ejari-private')
    now = datetime.now(timezone.utc)
    cutoff = now.strftime('%Y%m%d%H%M%S%f')[:17] + '~'
    deleted = 0
    for month in months((2026, 10), (now.year, now.month)):
        if deleted >= limit:
            break
        for row in expiry.query_entities('PartitionKey eq @month and RowKey le @cutoff',
                                         parameters={'month': month, 'cutoff': cutoff}):
            if deleted >= limit:
                break
            prefix = row['blobPrefix'] + '/'
            for blob in container.list_blobs(name_starts_with=prefix):
                container.delete_blob(blob.name)
            for key in (f"job_{row['jobId']}", row['idemKey']):
                try:
                    jobs.delete_entity(row['jobPartition'], key)
                except ResourceNotFoundError:
                    pass
            expiry.delete_entity(row['PartitionKey'], row['RowKey'])
            deleted += 1
    return deleted


if __name__ == '__main__':
    print({'expired_jobs_deleted': purge()})
