import unittest
from eth_abi import encode
import protocol_income_evidence as p


def receipt(liquidation=True):
    gas='0x'+'11'*20; active='0x'+'22'*20; recipient='0x'+'33'*20
    tx='0x'+'aa'*32; block='0x'+'bb'*32
    def transfer(sender,amount,index):
        return dict(address=p.WETH,topics=[p.TRANSFER,'0x'+'0'*24+sender[2:],'0x'+'0'*24+recipient[2:]],
                    data='0x'+encode(['uint256'],[amount]).hex(),logIndex=hex(index),transactionHash=tx,blockHash=block)
    logs=[transfer(gas,37500000000000000,1),transfer(active,1000000000000000,2)]
    if liquidation: logs.append(dict(address=p.MANAGER,topics=[p.LIQUIDATION],data='0x'+'00'*320))
    return dict(status='0x1',transactionHash=tx,blockHash=block,blockNumber='0x10',logs=logs,
                gasUsed=hex(300000),effectiveGasPrice=hex(10**9),**{'from':recipient}),gas,active


class IncomeTests(unittest.TestCase):
    def test_borrower_refund_is_not_liquidator_income(self):
        row,gas,active=receipt(False)
        self.assertIsNone(p.liquidation_payment(row,gas,active))

    def test_actual_transfers_minus_gas_still_do_not_become_full_profit(self):
        row,gas,active=receipt(); result=p.liquidation_payment(row,gas,active)
        self.assertEqual(result['rewardWethAtomic'],'38500000000000000')
        self.assertEqual(result['gasWei'],'300000000000000')
        self.assertEqual(result['rewardMinusTransactionGasAtomic'],'38200000000000000')
        self.assertIsNone(result['verifiedNetAtomic'])
        row['from']='0x'+'44'*20
        self.assertFalse(p.liquidation_payment(row,gas,active)['samePayerAndRecipient'])

    def test_duplicate_transfer_and_wrong_receipt_identity_are_rejected(self):
        row,gas,active=receipt(); row['logs'].append(row['logs'][0])
        with self.assertRaises(ValueError): p.liquidation_payment(row,gas,active)
        row,gas,active=receipt(); row['logs'][0]['blockHash']='0x'+'cc'*32
        with self.assertRaises(ValueError): p.liquidation_payment(row,gas,active)

    def test_wrong_asset_cannot_supply_reward(self):
        row,gas,active=receipt(); row['logs'][0]['address']='0x'+'55'*20
        with self.assertRaises(ValueError): p.liquidation_payment(row,gas,active)

    def test_noncanonical_abi_and_failed_receipts_are_not_payments(self):
        with self.assertRaises(ValueError): p.unpack('0x'+'00'*64,'uint256')
        row,gas,active=receipt(); row['status']='0x0'
        self.assertIsNone(p.liquidation_payment(row,gas,active))


if __name__=='__main__': unittest.main()
