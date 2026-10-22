"""Offline intent-schema compatibility probe; no strategy runner or signer."""
import importlib.metadata
import json
import socket
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def deny(*args, **kwargs):
    raise RuntimeError('Network and subprocesses are disabled in this offline probe')


if __name__ == '__main__':
    if importlib.metadata.version('almanak') != '2.29.2': raise ValueError('Unreviewed SDK version')
    socket.socket.connect = deny
    socket.socket.connect_ex = deny
    socket.create_connection = deny
    socket.getaddrinfo = deny
    class OfflinePopen(subprocess.Popen):
        def __init__(self, *args, **kwargs):
            deny()
    subprocess.Popen = OfflinePopen
    guard_checks = 0
    for operation in (lambda: socket.create_connection(('127.0.0.1',1)),
                      lambda: subprocess.Popen(['MIR_OFFLINE_GUARD_PROBE'])):
        try:
            operation()
        except RuntimeError as error:
            if str(error) != 'Network and subprocesses are disabled in this offline probe': raise
            guard_checks += 1
    if guard_checks != 2: raise ValueError('Probe guards failed')
    from almanak.framework.intents import HoldIntent
    hold = HoldIntent(reason='MIR evidence incomplete', reason_code='MIR_INSUFFICIENT_EVIDENCE',
                      intent_id='mir-offline-hold-v1', created_at=datetime(2026,10,22,tzinfo=timezone.utc))
    serialized = hold.serialize()
    restored = HoldIntent.deserialize(serialized)
    if restored.serialize() != serialized or str(serialized['type']).lower() != 'hold':
        raise ValueError('Intent round-trip mismatch')
    report = {'schemaVersion':1, 'sdk':'almanak/2.29.2', 'probe':'offline-hold-intent-schema',
              'intent':serialized, 'networkEnabled':False, 'subprocessesEnabled':False,
              'guardDenialChecks':guard_checks,
              'transactionSubmissions':0, 'qualified':False, 'netUsd':None,
              'limitations':['Intent schema only; strategy runner, compiler, backtest and fork integration not verified.',
                             'Python monkeypatches are probe guards, not an operating-system security sandbox.']}
    target = Path('outputs/almanak/offline-probe.json'); target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'sdk':report['sdk'],'probe':report['probe'],'status':'passed','transactionSubmissions':0}))
