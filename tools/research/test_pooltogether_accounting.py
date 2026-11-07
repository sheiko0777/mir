"""Independent hand-ledger fixtures; fictional receipt data, never market evidence."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest
from eth_abi import encode
from pooltogether_accounting import analyze, REFERENCE

POOL='0x45b2010d8a4f08b53c9fa7544c51dfd9733732cb'
CLAIMER='0xcdce635b774de77cdf791647601dba64a75547ba'
TOKEN='0x4200000000000000000000000000000000000006'
OP='0x'+'1'*40; VAULT='0x'+'2'*40; WINNER='0x'+'3'*40; PRIZE_RECIPIENT='0x'+'4'*40
TOPICS={
 'claim':'0x81d4e3306aa30f56dc9c3949abd8c27539b445f9ef380425f39f3f7114888e4f',
 'mirror':'0xeeb4ea63ac93d08466c88060e80ed42f0641debf45e931025fbb35faf5f2ad1a',
 'withdraw':'0xf4e9e956ba4b65051e84982c3ade043c89890cdbc452e9e446afe09cd4db40c8',
 'allocate':'0xecb1c952c58fd78de1639daecf690934ce9017bbd60ceaf3355f80ee8d24e737',
 'error':'0xc09b2fa185e7124c7aebcd0742e7cc3e30ef3fd28bb40faf120c2a363324df29',
 'transfer':'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'}


def fixture():
    def receipt(char,block,blockchar,gas,l1,operator,status='0x1'):
        return dict(transactionHash='0x'+char*64,blockNumber=hex(block),blockHash='0x'+blockchar*64,transactionIndex='0x1' if char=='f' else '0x0',
                    **{'from':OP},status=status,gasUsed=hex(gas),effectiveGasPrice='0x2',l1Fee=hex(l1),operatorFee=hex(operator),
                    logsComplete=True,logs=[])
    a=receipt('a',2,'b',100,3,0); b=receipt('e',3,'d',50,2,1); c=receipt('f',3,'d',25,1,1,'0x0')
    def log(tx,address,index,key,index_types,index_values,plain_types,plain_values):
        item=dict(address=address,transactionHash=tx['transactionHash'],blockHash=tx['blockHash'],blockNumber=tx['blockNumber'],
                  logIndex=hex(index),removed=False,topics=[TOPICS[key]]+['0x'+encode([t],[v]).hex() for t,v in zip(index_types,index_values)],
                  data='0x'+encode(plain_types,plain_values).hex())
        tx['logs'].append(item)
    log(a,POOL,0,'mirror',['address'],[OP],['uint256'],[20])
    log(a,POOL,1,'claim',['address']*3,[VAULT,WINNER,PRIZE_RECIPIENT],
        ['uint24','uint8','uint32','uint152','uint96','address'],[7,1,0,900,20,OP])
    log(a,TOKEN,2,'transfer',['address']*2,[POOL,PRIZE_RECIPIENT],['uint256'],[900])
    log(a,POOL,3,'allocate',['address'],[OP],['uint256'],[30])
    log(a,CLAIMER,4,'error',['address','uint8','address'],[VAULT,1,WINNER],['uint32','bytes'],[1,b'fictional test error'])
    log(b,TOKEN,5,'transfer',['address']*2,[POOL,OP],['uint256'],[50])
    log(b,POOL,6,'withdraw',['address']*2,[OP,OP],['uint256','uint256'],[50,50])
    return dict(schemaVersion=1,kind='pooltogether-reward-window',evidenceKind='illustrative',chainId=8453,operator=OP,
                windowCoverage='supplied-complete',openingRewardBalance=dict(blockNumber='0x1',blockHash='0x'+'c'*64,valueAtomic='0'),
                closingRewardBalance=dict(blockNumber='0x3',blockHash='0x'+'d'*64,valueAtomic='0'),receipts=[a,b,c])


class PoolTogetherAccountingTests(unittest.TestCase):
    def test_mirrors_and_winner_payout_not_revenue_withdrawal_costs_count_once(self):
        result=analyze(fixture())
        self.assertEqual(result['accruedClaimRewardsAtomic'],'20')
        self.assertEqual(result['reserveAllocationsAtomic'],'30')
        self.assertEqual(result['confirmedTransferToOperatorAtomic'],'50')
        self.assertEqual(result['withdrawnRewardCreditAtomic'],'50')
        self.assertEqual(result['knownExecutionFeesNativeAtomic'],'350')
        self.assertEqual(result['suppliedTotalFeesNativeAtomic'],'358')
        self.assertEqual(result['innerClaimErrors'],1)
        self.assertEqual(result['failedTransactions'],1)
        self.assertEqual(result['expectedClosingRewardBalanceAtomic'],'0')
        self.assertFalse(result['qualified']); self.assertIsNone(result['conditionalNetAtomic'])

    def test_accrual_without_withdrawal_is_not_cash(self):
        document=fixture(); document['receipts']=document['receipts'][:1]
        document['closingRewardBalance']['valueAtomic']='50'
        result=analyze(document)
        self.assertEqual(result['confirmedTransferToOperatorAtomic'],'0')
        self.assertEqual(result['accruedClaimRewardsAtomic'],'20')
        self.assertEqual(result['expectedClosingRewardBalanceAtomic'],'50')

    def test_self_withdrawal_does_not_imply_transfer(self):
        document=fixture(); tx=document['receipts'][1]; tx['logs']=tx['logs'][1:]
        tx['logs'][0]['topics'][2]='0x'+encode(['address'],[POOL]).hex()
        result=analyze(document)
        self.assertEqual(result['withdrawnBackToPoolAtomic'],'50')
        self.assertEqual(result['confirmedTransferToOperatorAtomic'],'0')
        self.assertEqual(result['findings'],[])

    def test_withdrawal_needs_matching_transfer(self):
        document=fixture(); document['receipts'][1]['logs']=document['receipts'][1]['logs'][1:]
        result=analyze(document)
        self.assertEqual(result['confirmedTransferToOperatorAtomic'],'0')
        self.assertEqual(len(result['findings']),1)

    def test_opening_balance_cannot_become_current_claim_income(self):
        document=fixture(); document['receipts'][0]['logs']=[]
        document['openingRewardBalance']['valueAtomic']='100'; document['closingRewardBalance']['valueAtomic']='50'
        document['receipts'][1]['logs'][1]['data']='0x'+encode(['uint256','uint256'],[50,100]).hex()
        result=analyze(document)
        self.assertEqual(result['accruedClaimRewardsAtomic'],'0')
        self.assertEqual(result['confirmedTransferToOperatorAtomic'],'50')
        self.assertEqual(result['expectedClosingRewardBalanceAtomic'],'50')
        self.assertIsNone(result['mirRevenueReceived'])

    def test_partial_window_or_missing_balances_cannot_reconcile_inventory(self):
        for mutate in (lambda d:d.update(windowCoverage='partial'),
                       lambda d:d.update(openingRewardBalance=None),
                       lambda d:d['receipts'][0].update(logsComplete=False)):
            document=fixture(); mutate(document)
            self.assertIsNone(analyze(document)['expectedClosingRewardBalanceAtomic'])

    def test_bad_abi_duplicates_reorgs_and_inventory_mismatch_rejected(self):
        for mutate in (lambda d:d['receipts'].append(d['receipts'][0]),
                       lambda d:d['receipts'][0]['logs'].append(d['receipts'][0]['logs'][0]),
                       lambda d:d['receipts'][0]['logs'][1].update(data=d['receipts'][0]['logs'][1]['data']+'00'*32),
                       lambda d:d['receipts'][0]['logs'][1].update(removed=True),
                       lambda d:d['receipts'][0]['logs'][1].update(blockHash='0x'+'9'*64),
                       lambda d:d['closingRewardBalance'].update(valueAtomic='1'),
                       lambda d:d['receipts'][1]['logs'][1].update(data='0x'+encode(['uint256','uint256'],[50,100]).hex()),
                       lambda d:d['receipts'][0]['logs'][0].update(data='0x'+encode(['uint256'],[99]).hex())):
            document=fixture(); mutate(document)
            with self.assertRaises(ValueError): analyze(document)

    def test_missing_l1_or_operator_fee_never_defaults_to_zero(self):
        document=fixture(); document['receipts'][1].pop('l1Fee')
        result=analyze(document)
        self.assertIsNone(result['suppliedTotalFeesNativeAtomic'])
        self.assertTrue(result['missingFeeComponents'])

    def test_other_payer_does_not_become_a_free_transaction(self):
        document=fixture(); document['receipts'][0]['from']='0x'+'9'*40
        result=analyze(document)
        self.assertEqual(len(result['unresolvedPayerTransactions']),1)
        self.assertIsNone(result['suppliedTotalFeesNativeAtomic'])

    def test_wrong_token_cannot_confirm_withdrawal_and_unrelated_log0_is_allowed(self):
        document=fixture(); document['receipts'][1]['logs'][0]['address']='0x'+'9'*40
        result=analyze(document)
        self.assertEqual(result['confirmedTransferToOperatorAtomic'],'0')
        self.assertTrue(result['findings'])
        document=fixture(); raw=deepcopy(document['receipts'][1]['logs'][-1])
        raw.update(address='0x'+'9'*40,topics=[],data='0x',logIndex='0x7')
        document['receipts'][1]['logs'].append(raw)
        self.assertEqual(analyze(document)['confirmedTransferToOperatorAtomic'],'50')


if __name__=='__main__':
    if sys.argv[1:]==['--write-fixture']:
        target=Path(__file__).with_name('fixtures')/'pooltogether-window-illustrative.json'
        target.write_text(json.dumps(fixture(),indent=2),encoding='utf-8')
        print(json.dumps({'file':str(target),'evidenceKind':'illustrative'}))
    else: unittest.main()
