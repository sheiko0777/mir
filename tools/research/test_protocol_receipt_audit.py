import unittest
from eth_abi import encode
import protocol_receipt_audit as audit
from test_protocol_income_evidence import receipt


class AuditTests(unittest.TestCase):
    def test_curve_requires_update_event_and_actual_lp_transfer(self):
        row,keeper,_=receipt(False)
        row['logs']=row['logs'][:1]
        self.assertIsNone(audit.curve_payment(row,keeper,audit.evidence.WETH))
        row['logs'].append(dict(address=keeper,topics=[audit.PROVIDE]))
        result=audit.curve_payment(row,keeper,audit.evidence.WETH)
        self.assertEqual(result['payouts'][0]['lpAtomic'],'37500000000000000')
        self.assertIsNone(result['verifiedNetAtomic'])
        burn=dict(row['logs'][0]); burn['logIndex']='0x4'
        burn['topics']=[audit.evidence.TRANSFER,burn['topics'][1],'0x'+'0'*64]
        burn['data']='0x'+encode(['uint256'],[10**25]).hex()
        row['logs'].append(burn)
        self.assertEqual(len(audit.curve_payment(row,keeper,audit.evidence.WETH)['payouts']),1)
        row['logs'].append(dict(address=keeper,topics=[audit.PROFIT]))
        self.assertEqual(audit.curve_payment(row,keeper,audit.evidence.WETH)['status'],'mixed-caller-and-protocol-profit-unresolved')

    def test_protocol_withdrawal_alone_is_not_a_caller_payment(self):
        row,keeper,_=receipt(False)
        row['logs'].append(dict(address=keeper,topics=[audit.PROFIT]))
        self.assertIsNone(audit.curve_payment(row,keeper,audit.evidence.WETH))

    def test_selection_includes_all_liquity_receipts_and_caps_curve_sample(self):
        gas='gas'; keeper='keeper'
        doc=dict(records=[dict(method='alchemy_getAssetTransfers',params=[dict(fromAddress=address)],
                              result=dict(transfers=[dict(hash=str(i)) for i in range(count)]))
                          for address,count in [(gas,89),(keeper,100)]])
        sets,hashes=audit.selection(doc,dict(liquity=dict(gasPool=gas)))
        self.assertEqual(len(sets[gas]),89); self.assertEqual(len(sets[keeper]),4)
        self.assertEqual(len(hashes),89)
        doc['records'][0]['result']['transfers']=[dict(hash=str(i)) for i in range(129)]
        with self.assertRaises(ValueError): audit.selection(doc,dict(liquity=dict(gasPool=gas)))


if __name__=='__main__': unittest.main()
