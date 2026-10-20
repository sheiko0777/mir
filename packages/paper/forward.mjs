import { createHash } from 'node:crypto';
import { normalizeResearch } from '../../apps/server/research.mjs';

// A bounded forward quote experiment, deliberately separate from funded PaperLedger fills.
export const MAX_EXPERIMENTS = 32;
const integer = x => Number.isSafeInteger(x) && x >= 0;
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const copy = x => JSON.parse(JSON.stringify(x));
const pin = a => ({ blockNumber: a.snapshot.blockNumber, blockHash: a.snapshot.blockHash,
  capturedAtMs: a.snapshot.capturedAtMs, observedAtMs: a.snapshot.observedAtMs });
const identity = c => [c.buyPool, c.sellPool, c.buyVenue, c.sellVenue, c.inputQuote];
function compact(archive) {
  const result = copy({ snapshot: archive?.snapshot, sizingInputs: archive?.sizingInputs });
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw new Error('Forward snapshot exceeds limit');
  return result;
}
function experimentId(archive, createdAtMs, delayMs, horizonMs) {
  return digest({ archive, createdAtMs, delayMs, horizonMs });
}
function entryView(record) {
  const view = normalizeResearch(record.entryArchive, record.createdAtMs);
  if (view.freshness !== 'recent-capture' || !view.analysis.bestScenario) throw new Error('Invalid forward entry');
  return view;
}
function replay(record, archive, nowMs) {
  const entry = entryView(record), selected = entry.analysis.bestScenario;
  const source = archive.snapshot, previous = record.entryArchive.snapshot;
  if (source.blockNumber <= previous.blockNumber || source.blockHash === previous.blockHash ||
      source.capturedAtMs < record.createdAtMs + record.delayMs ||
      source.observedAtMs < record.createdAtMs + record.delayMs ||
      source.capturedAtMs > nowMs || nowMs > record.createdAtMs + record.horizonMs) return null;
  const data = { snapshot: source, sizingInputs: { ...record.entryArchive.sizingInputs, inputsQuote: [selected.inputQuote] } };
  const later = normalizeResearch(data, nowMs);
  if (later.freshness !== 'recent-capture' || later.analysis.quoteToken !== entry.analysis.quoteToken ||
      later.analysis.quoteDecimals !== entry.analysis.quoteDecimals) return null;
  const a = previous.pools.find(p => p.address === selected.buyPool), b = source.pools.find(p => p.address === selected.buyPool);
  const c = previous.pools.find(p => p.address === selected.sellPool), d = source.pools.find(p => p.address === selected.sellPool);
  if (!b || !d || [a, c].some((p, i) => ['baseToken', 'quoteToken', 'baseDecimals', 'quoteDecimals', 'feeBps', 'factory']
    .some(key => p[key] !== [b, d][i][key]))) return null;
  // Freeze direction, size and cost policy before seeing this later block. Never rank later winners.
  const candidate = later.analysis.candidates.find(x => JSON.stringify(identity(x)) === JSON.stringify(identity(selected)));
  return candidate ? { archive: compact(data), candidate } : null;
}

export function emptyForwardJournal() {
  return { schemaVersion: 1, mode: 'forward-quote-experiments', lastSource: null, records: [] };
}
export function validateForwardJournal(journal) {
  if (!journal || journal.schemaVersion !== 1 || journal.mode !== 'forward-quote-experiments' ||
      !Array.isArray(journal.records) || journal.records.length > MAX_EXPERIMENTS) throw new Error('Invalid forward journal');
  const ids = new Set();
  for (const record of journal.records) {
    if (!integer(record.createdAtMs) || !integer(record.delayMs) || record.delayMs < 1000 ||
        !integer(record.horizonMs) || record.horizonMs <= record.delayMs || record.horizonMs > 86400000 ||
        !Number.isSafeInteger(record.createdAtMs + record.horizonMs) ||
        !['pending', 'observed', 'expired'].includes(record.status) ||
        record.id !== experimentId(record.entryArchive, record.createdAtMs, record.delayMs, record.horizonMs) || ids.has(record.id)) {
      throw new Error('Invalid forward record');
    }
    compact(record.entryArchive); entryView(record); ids.add(record.id);
    if (record.status === 'observed') {
      if (!integer(record.closedAtMs) || !record.outcomeArchive || !replay(record, record.outcomeArchive, record.closedAtMs) ||
          JSON.stringify(record.outcomeArchive.sizingInputs) !== JSON.stringify({ ...record.entryArchive.sizingInputs,
            inputsQuote: [entryView(record).analysis.bestScenario.inputQuote] })) throw new Error('Invalid forward outcome');
    } else if (record.outcomeArchive !== null || (record.status === 'pending' ? record.closedAtMs !== null :
      !integer(record.closedAtMs) || record.closedAtMs <= record.createdAtMs + record.horizonMs)) throw new Error('Invalid forward closure');
  }
  const last = journal.lastSource;
  if (last !== null && (!integer(last.blockNumber) || !/^0x[0-9a-f]{64}$/.test(last.blockHash) ||
      !integer(last.capturedAtMs) || !integer(last.observedAtMs) || last.observedAtMs > last.capturedAtMs)) throw new Error('Invalid forward source');
  if (journal.records.some(r => [r.entryArchive, r.outcomeArchive].filter(Boolean).some(a => !last ||
      a.snapshot.blockNumber > last.blockNumber || a.snapshot.capturedAtMs > last.capturedAtMs ||
      a.snapshot.observedAtMs > last.observedAtMs ||
      a.snapshot.blockNumber === last.blockNumber && a.snapshot.blockHash !== last.blockHash))) throw new Error('Forward source regression');
  return journal;
}

export function advanceForward(journal, archive, { nowMs = Date.now(), delayMs = 60000, horizonMs = 21600000 } = {}) {
  validateForwardJournal(journal);
  if (!integer(nowMs) || !integer(delayMs) || delayMs < 1000 || !integer(horizonMs) || horizonMs <= delayMs ||
      horizonMs > 86400000 || !Number.isSafeInteger(nowMs + horizonMs)) throw new Error('Invalid forward timing policy');
  if (journal.records.some(r => r.createdAtMs > nowMs || r.closedAtMs !== null && r.closedAtMs > nowMs)) {
    throw new Error('Forward wall-clock regression');
  }
  const next = copy(journal), actions = [];
  // Expiration uses wall clock even if no new usable source arrives.
  for (const record of next.records) if (record.status === 'pending' && nowMs > record.createdAtMs + record.horizonMs) {
    record.status = 'expired'; record.closedAtMs = nowMs; actions.push({ id: record.id, action: 'expired' });
  }
  if (!archive) return { journal: next, actions, reason: 'RESEARCH_UNAVAILABLE' };
  const current = compact(archive), view = normalizeResearch(current, nowMs), source = pin(current), last = next.lastSource;
  if (last && (source.blockNumber < last.blockNumber || source.blockNumber === last.blockNumber && source.blockHash !== last.blockHash ||
      source.capturedAtMs < last.capturedAtMs || source.observedAtMs < last.observedAtMs)) throw new Error('Forward source conflict or regression');
  if (view.freshness !== 'recent-capture') return { journal: next, actions, reason: 'STALE_OR_FUTURE_CAPTURE' };
  if (last && source.blockNumber === last.blockNumber) return { journal: next, actions, reason: 'DUPLICATE_BLOCK' };
  for (const record of next.records.filter(r => r.status === 'pending')) {
    const later = replay(record, current, nowMs);
    if (later) {
      record.status = 'observed'; record.closedAtMs = nowMs; record.outcomeArchive = later.archive;
      actions.push({ id: record.id, action: 'observed' });
    }
  }
  next.lastSource = source;
  if (view.analysis.bestScenario && next.records.length < MAX_EXPERIMENTS) {
    const record = { id: experimentId(current, nowMs, delayMs, horizonMs), createdAtMs: nowMs, delayMs, horizonMs,
      entryArchive: current, status: 'pending', closedAtMs: null, outcomeArchive: null };
    next.records.push(record); actions.push({ id: record.id, action: 'registered' });
  }
  return { journal: next, actions, reason: next.records.length >= MAX_EXPERIMENTS ? 'JOURNAL_CAPACITY_REACHED' :
    view.analysis.bestScenario ? 'PROCESSED' : 'NO_COSTED_ENTRY' };
}

export function summarizeForward(journal) {
  validateForwardJournal(journal);
  const records = journal.records.map(record => {
    const entry = entryView(record), selected = entry.analysis.bestScenario;
    const outcome = record.status === 'observed' ? replay(record, record.outcomeArchive, record.closedAtMs).candidate : null;
    return { id: record.id, status: record.status, registeredAtMs: record.createdAtMs,
      entry: pin(record.entryArchive), outcome: record.outcomeArchive ? pin(record.outcomeArchive) : null,
      quoteToken: entry.analysis.quoteToken, quoteDecimals: entry.analysis.quoteDecimals, quoteLabel: entry.quoteLabel,
      buyPool: selected.buyPool, sellPool: selected.sellPool, inputQuote: selected.inputQuote,
      frozenPolicy: copy(record.entryArchive.sizingInputs),
      initialScenarioNetQuote: selected.scenarioNetQuote, laterScenarioNetQuote: outcome?.scenarioNetQuote ?? null,
      initialAboveThreshold: BigInt(selected.scenarioNetQuote) > BigInt(record.entryArchive.sizingInputs.minNetQuote),
      laterAboveThreshold: outcome?.scenarioNetQuote == null ? null : outcome.withinResearchConstraints &&
        BigInt(outcome.scenarioNetQuote) > BigInt(record.entryArchive.sizingInputs.minNetQuote),
      scenarioChangeQuote: outcome?.scenarioNetQuote == null ? null :
        (BigInt(outcome.scenarioNetQuote) - BigInt(selected.scenarioNetQuote)).toString(),
      withinLaterConstraints: outcome?.withinResearchConstraints ?? null,
      observedDelayMs: record.outcomeArchive ? record.outcomeArchive.snapshot.observedAtMs - record.createdAtMs : null,
      reasons: outcome?.reasons ?? selected.reasons, qualified: false, actualNetQuote: null };
  });
  return { schemaVersion: 1, mode: 'forward-quote-experiments', records,
    counts: Object.fromEntries(['pending', 'observed', 'expired'].map(s => [s, records.filter(r => r.status === s).length])),
    paperFills: 0, qualifiedOpportunities: 0, netProfitKnown: false,
    limitations: ['Forward reserve-quote replay, not a simulated transaction or realized profit.',
      'Overlapping experiments have no shared capital; their results must not be summed as portfolio PnL.',
      'Gas units, priority fee and buffer stay frozen assumptions; later pinned base fee may change.',
      'First comparable captured block after the delay is used; missed blocks and execution conditions are unknown.',
      'No independent token behavior, transfer tax, MEV, approval or revert evidence.'] };
}
