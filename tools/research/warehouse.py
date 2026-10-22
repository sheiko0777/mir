"""Rebuild a local Parquet view from integrity-checked MIR Lab funding objects."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from funding_probe import summarize


def rebuild(root=Path('data/lab')):
    records, funding_datasets = [], 0
    files = sorted((root / 'datasets').glob('*.json'))
    if len(files) > 1000:
        raise ValueError('Dataset count exceeds bound')
    for file in files:
        if file.stat().st_size > 8 * 1024 * 1024:
            raise ValueError('Dataset exceeds bound')
        raw = file.read_bytes()
        if hashlib.sha256(raw).hexdigest() != file.stem:
            raise ValueError('Dataset hash mismatch')
        data = json.loads(raw)
        if data['kind'] == 'market-snapshot':
            continue  # Separate raw evidence; never mix depth snapshots into funding rows.
        if data['kind'] != 'funding-history' or data['source'] != 'https://api.hyperliquid.xyz/info':
            raise ValueError('Unsupported dataset')
        summarize(data['rows'], data['asset'], data['startMs'], data['endMs'])
        funding_datasets += 1
        for row in data['rows']:
            records.append({'dataset_id': file.stem, 'asset': data['asset'],
                            'event_time_ms': row['time'], 'captured_at_ms': data['capturedAtMs'],
                            'funding_rate_decimal': row['fundingRate'], 'source': data['source']})
    schema = pa.schema([('dataset_id', pa.string()), ('asset', pa.string()),
                        ('event_time_ms', pa.int64()), ('captured_at_ms', pa.int64()),
                        ('funding_rate_decimal', pa.string()), ('source', pa.string())])
    table = pa.Table.from_pylist(records, schema=schema)
    directory = root / 'warehouse'
    directory.mkdir(parents=True, exist_ok=True)
    temp = directory / f'funding-{os.getpid()}.tmp.parquet'
    target = directory / 'funding.parquet'
    try:
        pq.write_table(table, temp, compression='zstd')
        with duckdb.connect(':memory:') as db:
            # Query the derived file, rather than counting the in-memory input.
            counts = db.execute('SELECT asset, count(*) FROM read_parquet(?) GROUP BY asset ORDER BY asset',
                                [str(temp)]).fetchall()
        if sum(count for _, count in counts) != len(records):
            raise ValueError('Warehouse row reconciliation failed')
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    return {'file': str(target.resolve()), 'datasets': funding_datasets, 'rows': len(records), 'counts': counts,
            'versions': {name: importlib.metadata.version(name) for name in ('duckdb', 'pyarrow')},
            'note': 'Overlapping datasets remain distinct; do not aggregate funding across dataset IDs.'}


if __name__ == '__main__':
    print(json.dumps(rebuild()))
