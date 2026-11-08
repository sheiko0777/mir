"""Offline observation journal. Samples never imply fills, continuous signals or profit."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import liquity_inventory as inventory
import liquity_screen as base


def summarize(samples, rejected=None):
    rejected = list(rejected or []); accepted = []; heights = {}
    for evidence_id, sample in samples:
        key = (sample['chainId'], sample['manager'], sample['blockNumber'])
        heights.setdefault(key, []).append((evidence_id, sample))
    for group in heights.values():
        if len({sample['blockHash'] for _, sample in group}) > 1:
            rejected.extend(dict(id=evidence_id, reason='CONFLICTING_BLOCK_HASH') for evidence_id, _ in group)
        else:
            accepted.append(group[0])
            rejected.extend(dict(id=evidence_id, reason='DUPLICATE_BLOCK_SAMPLE') for evidence_id, _ in group[1:])
    observations = []; previous = None
    for evidence_id, sample in sorted(accepted, key=lambda pair: pair[1]['blockNumber']):
        current = None if sample['candidates'] is None else {row['troveId'] for row in sample['candidates']}
        gap = None if previous is None else (sample['blockTimestampMs'] - previous['timestamp']) // 1000
        comparable = previous is not None and current is not None and previous['ids'] is not None
        if gap is not None and gap <= 0:
            rejected.append(dict(id=evidence_id, reason='NONINCREASING_EVENT_TIME')); continue
        observations.append(dict(id=evidence_id, blockNumber=sample['blockNumber'], blockHash=sample['blockHash'],
                                 blockTimestampMs=sample['blockTimestampMs'], coverage=sample['coverage'],
                                 candidates=None if current is None else sorted(current),
                                 newlyObserved=sorted(current - previous['ids']) if comparable else None,
                                 noLongerObserved=sorted(previous['ids'] - current) if comparable else None,
                                 elapsedSincePreviousSampleSeconds=gap,
                                 continuousSignalVerified=False, executionOutcome='unknown', verifiedNetAtomic=None))
        previous = dict(timestamp=sample['blockTimestampMs'], ids=current)
    return dict(schemaVersion=1, kind='liquity-paper-observation-journal', observations=observations,
                rejectedInputs=rejected, observationCount=len(observations),
                observedSpanSeconds=(observations[-1]['blockTimestampMs'] - observations[0]['blockTimestampMs']) // 1000 if observations else 0,
                continuousMonitoringDurationSeconds=None, competitionMeasured=False,
                fills=0, fillsMeaning='No execution attempted; not a measured fill rate',
                qualified=False, verifiedNetAtomic=None,
                limitations=['Point samples only; intervening events are unknown',
                             'Disappearance is not evidence of a competitor fill or liquidation',
                             'No profitability, operating cost, failure rate or opportunity-frequency estimate'])


def build(captures, baselines):
    if not 1 <= len(captures) <= 50 or not 1 <= len(baselines) <= 50:
        raise ValueError('Journal input budget exceeded')
    lookup = {path.stem: path for path in baselines}
    samples = []; rejected = []
    for path in captures:
        evidence_id = path.stem if re.fullmatch('[0-9a-f]{64}', path.stem) else 'invalid-name'
        try:
            doc = inventory.identity(path)
            baseline = lookup[doc['baselineSha256']]
            sample = inventory.replay(path, baseline)
            samples.append((evidence_id, sample))
        except Exception:
            # Preserve invalid/failed evidence as rejected; never silently select only winners.
            rejected.append(dict(id=evidence_id, reason='INCOMPLETE_OR_INVALID_EVIDENCE'))
    report = summarize(samples, rejected)
    report['inputCaptureIds'] = [path.stem if re.fullmatch('[0-9a-f]{64}', path.stem) else 'invalid-name' for path in captures]
    report['engineSha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture', required=True, action='append', type=Path)
    parser.add_argument('--baseline', required=True, action='append', type=Path)
    args = parser.parse_args(); report = build(args.capture, args.baseline)
    raw = json.dumps(report, sort_keys=True, allow_nan=False).encode(); name = hashlib.sha256(raw).hexdigest()
    folder = base.ROOT / 'data/liquity-paper'; folder.mkdir(parents=True, exist_ok=True)
    target = folder / (name + '.json')
    if target.exists():
        if target.read_bytes() != raw: raise ValueError('Journal identity collision')
    else:
        with target.open('xb') as stream: stream.write(raw)
    print(json.dumps(dict(id=name, observations=report['observationCount'], rejected=len(report['rejectedInputs']),
                          observedSpanSeconds=report['observedSpanSeconds'], qualified=False, verifiedNetAtomic=None)))


if __name__ == '__main__': main()
