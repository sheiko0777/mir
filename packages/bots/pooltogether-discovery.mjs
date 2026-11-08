import reference from './pooltogether-reads.json' with { type: 'json' };

export const CLAIM_EVENT_TOPIC = '0x81d4e3306aa30f56dc9c3949abd8c27539b445f9ef380425f39f3f7114888e4f';
export const DISCOVERY_LIMITS = Object.freeze({ maxLookbackBlocks: 512, maxLogs: 128,
  maxParticipants: 4, maxIndicesPerParticipant: 4 });
const hash = /^0x[0-9a-f]{64}$/;
const quantity = value => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw new Error('Invalid event quantity');
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n)) throw new Error('Event quantity overflow');
  return n;
};
const addressWord = word => {
  if (typeof word !== 'string' || !/^0x0{24}[0-9a-f]{40}$/.test(word) || BigInt(word) === 0n) throw new Error('Invalid event address');
  return '0x' + word.slice(-40);
};

export function validateSeedDiscovery(discovery) {
  if (discovery === undefined) return;
  if (discovery?.kind !== 'recent-claim-participants' || Object.keys(discovery).length !== 2 ||
      !Number.isInteger(discovery.lookbackBlocks) || discovery.lookbackBlocks < 1 ||
      discovery.lookbackBlocks > DISCOVERY_LIMITS.maxLookbackBlocks) throw new Error('Invalid seed discovery policy');
}

// A bounded, biased bootstrap from previous claims, NOT an eligible-holder index.
// Monetary log fields are width-checked but never turned into MIR revenue.
export function parseClaimParticipants(logs, { fromBlock, toBlock, drawId }) {
  if (!Array.isArray(logs) || logs.length > DISCOVERY_LIMITS.maxLogs ||
      !Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 ||
      toBlock < fromBlock || toBlock - fromBlock >= DISCOVERY_LIMITS.maxLookbackBlocks ||
      typeof drawId !== 'bigint' || drawId < 0n || drawId >= 2n ** 24n) throw new Error('Invalid claim event window');
  const seen = new Set(), decoded = [], blockHashes = new Map();
  for (const log of logs) {
    if (log?.address !== reference.pool || log.removed !== false || !Array.isArray(log.topics) ||
        log.topics.length !== 4 || log.topics[0] !== CLAIM_EVENT_TOPIC ||
        !hash.test(log.blockHash) || !hash.test(log.transactionHash) ||
        typeof log.data !== 'string' || !/^0x[0-9a-f]{384}$/.test(log.data)) throw new Error('Invalid ClaimedPrize log');
    const vault = addressWord(log.topics[1]), winner = addressWord(log.topics[2]);
    addressWord(log.topics[3]);
    const blockNumber = quantity(log.blockNumber), transactionIndex = quantity(log.transactionIndex), logIndex = quantity(log.logIndex);
    if (blockNumber < fromBlock || blockNumber > toBlock) throw new Error('Claim event outside window');
    if (blockHashes.has(blockNumber) && blockHashes.get(blockNumber) !== log.blockHash) throw new Error('Conflicting claim event blocks');
    blockHashes.set(blockNumber, log.blockHash);
    const key = `${log.blockHash}:${log.logIndex}`;
    if (seen.has(key)) throw new Error('Duplicate claim event');
    seen.add(key);
    const fields = Array.from({ length: 6 }, (_, i) => BigInt('0x' + log.data.slice(2 + i * 64, 66 + i * 64)));
    for (let i = 0; i < fields.length; i++) if (fields[i] >= 2n ** BigInt([24, 8, 32, 152, 96, 160][i])) throw new Error('Claim event ABI overflow');
    if (fields[0] === 0n || fields[0] > drawId) throw new Error('Claim event has invalid draw');
    decoded.push({ vault, winner, tier: Number(fields[1]), observedPrizeIndex: Number(fields[2]),
      sourceDrawId: fields[0].toString(), blockNumber, blockHash: log.blockHash,
      transactionHash: log.transactionHash, transactionIndex, logIndex });
  }
  decoded.sort((a, b) => b.blockNumber - a.blockNumber || b.transactionIndex - a.transactionIndex || b.logIndex - a.logIndex);
  const participants = [], identities = new Set();
  for (const row of decoded) {
    const key = `${row.vault}:${row.winner}:${row.tier}`;
    if (identities.has(key)) continue;
    identities.add(key);
    if (participants.length < DISCOVERY_LIMITS.maxParticipants) participants.push(row);
  }
  return { participants, eventsObserved: logs.length, distinctParticipantTiersObserved: identities.size,
    selectedParticipants: participants.length, selection: 'most-recent-distinct-vault-winner-tier',
    coversAllEligibleAccounts: false, completeHistory: false, providerCompletenessIndependentlyVerified: false };
}

export async function discoverClaimSeeds(read, { header, drawId, discovery, existingSeeds }) {
  validateSeedDiscovery(discovery);
  const toBlock = quantity(header.number), fromBlock = Math.max(0, toBlock - discovery.lookbackBlocks + 1);
  const logs = await read('eth_getLogs', [{ address: reference.pool, topics: [CLAIM_EVENT_TOPIC],
    fromBlock: '0x' + fromBlock.toString(16), toBlock: header.number }]);
  const parsed = parseClaimParticipants(logs, { fromBlock, toBlock, drawId });
  const checked = new Map(), seeds = [...existingSeeds];
  const identities = new Set(seeds.map(s => `${s.vault}:${s.winner}:${s.tier}:${s.prizeIndex}`));
  for (const participant of parsed.participants) {
    if (!checked.has(participant.blockNumber)) {
      const block = await read('eth_getBlockByNumber', ['0x' + participant.blockNumber.toString(16), false]);
      if (block?.hash !== participant.blockHash || quantity(block.number) !== participant.blockNumber) throw new Error('Claim source block is no longer canonical');
      checked.set(participant.blockNumber, participant.blockHash);
    } else if (checked.get(participant.blockNumber) !== participant.blockHash) throw new Error('Conflicting source block hashes');
    const indices = [...new Set([participant.observedPrizeIndex, 0, 1, 2, 3])].slice(0, DISCOVERY_LIMITS.maxIndicesPerParticipant);
    for (const prizeIndex of indices) {
      const seed = { vault: participant.vault, winner: participant.winner, tier: participant.tier, prizeIndex };
      const id = `${seed.vault}:${seed.winner}:${seed.tier}:${seed.prizeIndex}`;
      if (seeds.length < 16 && !identities.has(id)) { seeds.push(seed); identities.add(id); }
    }
  }
  return { seeds, coverage: { ...parsed, kind: discovery.kind, fromBlock, toBlock,
    blockHashesChecked: checked.size, addedSeeds: seeds.length - existingSeeds.length,
    maxSeeds: 16, source: 'historical-claim-participant-sample-not-holder-index',
    sampleBias: 'previous winners; same observed tier and only four sampled prize indices per participant' } };
}
