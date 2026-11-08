import copy
from pathlib import Path
import unittest
from unittest.mock import patch
from liquity_paper_journal import summarize, build


def sample(number=1, timestamp=1000, ids=None):
    return dict(chainId=1, manager='fixed-weth-manager', blockNumber=number, blockHash='hash-'+str(number),
                blockTimestampMs=timestamp, coverage={'allTrackedPositionsScreened': True},
                candidates=[dict(troveId=value) for value in (ids or [])])


class JournalTests(unittest.TestCase):
    def test_disappearance_and_long_gap_do_not_become_a_fill_or_continuous_signal(self):
        result = summarize([('a', sample(ids=['7'])), ('b', sample(3, 86401000))])
        latest = result['observations'][1]
        self.assertEqual(latest['noLongerObserved'], ['7'])
        self.assertEqual(latest['executionOutcome'], 'unknown')
        self.assertFalse(latest['continuousSignalVerified'])
        self.assertIsNone(result['continuousMonitoringDurationSeconds'])
        self.assertIsNone(result['verifiedNetAtomic']); self.assertFalse(result['qualified'])

    def test_unknown_candidates_are_not_reported_as_zero_or_lost(self):
        unknown = sample(2, 2000); unknown['candidates'] = None
        result = summarize([('a', sample(ids=['7'])), ('b', unknown), ('c', sample(3, 3000))])
        self.assertIsNone(result['observations'][1]['candidates'])
        self.assertIsNone(result['observations'][2]['noLongerObserved'])

    def test_duplicate_reorg_and_nonincreasing_times_remain_in_rejections(self):
        original = sample(); conflict = copy.deepcopy(original); conflict['blockHash'] = 'changed'
        result = summarize([('a', original), ('b', conflict)])
        self.assertEqual(result['observationCount'], 0)
        self.assertEqual(len(result['rejectedInputs']), 2)
        result = summarize([('a', original), ('b', original), ('c', sample(2, 999))])
        self.assertEqual(result['observationCount'], 1)
        self.assertEqual({x['reason'] for x in result['rejectedInputs']}, {'DUPLICATE_BLOCK_SAMPLE', 'NONINCREASING_EVENT_TIME'})

    def test_invalid_evidence_is_preserved_and_input_budget_is_enforced(self):
        with patch('liquity_paper_journal.inventory.identity', side_effect=ValueError('bad evidence')):
            result = build([Path('0'*64+'.json')], [Path('1'*64+'.json')])
        self.assertEqual(result['observationCount'], 0)
        self.assertEqual(result['rejectedInputs'][0]['reason'], 'INCOMPLETE_OR_INVALID_EVIDENCE')
        with self.assertRaises(ValueError): build([], [])


if __name__ == '__main__': unittest.main()
