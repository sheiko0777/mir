/* MIR workspace: saved observations by default; mock figures load only by explicit selection. */
const byId = id => document.getElementById(id);
const shortAddress = value => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : 'Unknown';
const venueNames = { 'uniswap-v2': 'Uniswap V2', 'sushiswap-v2': 'SushiSwap V2' };
const tokenNames = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC'
};
const evidenceNames = { unknown: 'Unknown', review: 'Review needed', blocked: 'Blocked' };
let dataset = null;
let generation = 0;
let returnFocus = null;
let marketView = 'all';
let watchlist = new Set();
try { watchlist = new Set(JSON.parse(localStorage.getItem('mir-watchlist') ?? '[]')); } catch {}
const poolKey = pool => `${dataset?.dataset}:${pool.pool ?? pool.id ?? pairName(pool)}:${pool.venue}`;
function syncTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.querySelectorAll('.theme-toggle').forEach(button => button.setAttribute('aria-label', `Switch to ${next} theme`));
}
document.querySelectorAll('.theme-toggle').forEach(button => button.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('mir-theme', theme); } catch {}
  syncTheme();
}));
syncTheme();
function formatAtomic(value, decimals, places = 6) {
  if (value == null || decimals == null) return 'Unknown';
  const digits = value.padStart(decimals + 1, '0');
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals ? digits.slice(-decimals).slice(0, places).replace(/0+$/, '') : '';
  if (BigInt(value) > 0n && BigInt(whole) === 0n && !fraction) {
    const precision = Math.min(decimals, places);
    return `<0.${'0'.repeat(Math.max(0, precision - 1))}1`;
  }
  return whole + (fraction ? `.${fraction}` : '');
}
function pairName(pool) { return pool.pair ?? pool.tokens.map(t => tokenNames[t] ?? shortAddress(t)).join(' / '); }
function setBanner(title, detail, freshness) {
  const banner = byId('source-banner');
  banner.querySelector('strong').textContent = title;
  banner.querySelector('span').textContent = detail;
  banner.dataset.freshness = freshness;
}
function filtered() {
  const query = byId('pool-search').value.trim().toLowerCase();
  const risk = byId('risk-filter').value;
  return (dataset?.observations ?? []).filter(p =>
    `${pairName(p)} ${p.pool ?? ''} ${(p.tokens ?? []).join(' ')}`.toLowerCase().includes(query) &&
    (risk === 'all' || p.evidence === risk) &&
    (marketView !== 'new' || p.classification === 'NEW_SINCE_CHECKPOINT') &&
    (marketView !== 'watchlist' || watchlist.has(poolKey(p))));
}
function render() {
  const rows = byId('pool-rows');
  rows.replaceChildren();
  for (const [index, pool] of filtered().entries()) {
    const row = document.createElement('tr');
    const reserve = pool.reserveDisplay ?? (pool.quoteLabel && pool.quoteReserve != null ? `${formatAtomic(pool.quoteReserve, pool.quoteDecimals)} ${pool.quoteLabel}` : 'Unknown');
    const gap = pool.gapDisplay ?? (pool.spotGapBps == null ? 'Unknown' : `${formatAtomic(pool.spotGapBps, 2, 2)}%`);
    for (const value of [String(index + 1), pairName(pool), '◆ ETH', venueNames[pool.venue] ?? pool.venue, reserve, gap]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    const pairCell = row.children[1]; pairCell.className = 'token-cell';
    const avatar = document.createElement('span'); avatar.className = 'token-avatar'; avatar.dataset.color = String(index % 4); avatar.textContent = pool.pair ? pool.pair[0] : '◇'; avatar.setAttribute('aria-hidden', 'true'); pairCell.prepend(avatar);
    row.children[2].className = 'chain-marker';
    if (!pool.pair) { pairCell.classList.add('address-pair'); pairCell.title = pool.tokens.join(' / '); }
    const evidence = document.createElement('td');
    const status = document.createElement('mir-status');
    status.setAttribute('state', pool.evidence); status.textContent = evidenceNames[pool.evidence] ?? 'Unknown'; evidence.append(status); row.append(evidence);
    const action = document.createElement('td'); const button = document.createElement('button');
    button.className = 'row-action'; button.type = 'button'; button.textContent = 'Inspect';
    button.setAttribute('aria-label', `Inspect ${pairName(pool)}`);
    button.addEventListener('click', () => showEvidence(pool, button)); action.append(button); row.append(action); rows.append(row);
  }
  byId('no-results').hidden = filtered().length !== 0;
  document.querySelector('.result-count').textContent = `${filtered().length} observation(s)`;
}
function showEvidence(pool, button) {
  const sample = dataset.dataset === 'mock-sample';
  byId('dialog-title').textContent = pairName(pool);
  document.querySelector('.dialog-head .eyebrow').textContent = sample ? 'MOCK SAMPLE EVIDENCE' : 'SAVED OBSERVATION EVIDENCE';
  const content = byId('dialog-content'); content.replaceChildren();
  const details = document.createElement('dl'); details.className = 'observation-details';
  const fields = [['Dataset', sample ? 'MOCK SAMPLE — illustrative' : 'Saved on-chain report; not live'],
    ['Pool', pool.pool ?? 'Illustrative only'], ['Token addresses', pool.tokens?.join(' / ') ?? 'Illustrative only'],
    ['Source', venueNames[pool.venue] ?? pool.venue], ['Block', pool.blockNumber ?? 'Illustrative only'],
    ['Block hash', pool.blockHash ?? 'Illustrative only'], ['Freshness', pool.freshness ?? 'Sample'],
    ['Token age', 'Unknown — a new pool is not proof of a new token'],
    ['Net profit', 'Unknown — gas and risk evidence incomplete'], ['Qualification', 'Unqualified · no execution'],
    ['Reasons', pool.reasons.join(', ')]];
  for (const [label, value] of fields) {
    const term = document.createElement('dt'); term.textContent = label;
    const description = document.createElement('dd'); description.textContent = String(value); details.append(term, description);
  }
  content.append(details);
  const watchButton = document.createElement('button'); watchButton.type = 'button'; watchButton.className = 'button small watch-button';
  const syncWatch = () => { watchButton.textContent = watchlist.has(poolKey(pool)) ? 'Remove from watchlist' : 'Add to watchlist'; };
  syncWatch(); watchButton.addEventListener('click', () => {
    const key = poolKey(pool); watchlist.has(key) ? watchlist.delete(key) : watchlist.add(key);
    try { localStorage.setItem('mir-watchlist', JSON.stringify([...watchlist])); } catch {}
    syncWatch(); render();
  }); content.append(watchButton);
  returnFocus = button; byId('evidence-dialog').showModal();
}
async function loadDataset() {
  const current = ++generation;
  const sample = byId('dataset-mode').value === 'sample';
  document.querySelector('.observations .eyebrow').textContent = sample ? 'MOCK SAMPLE OBSERVATIONS' : 'SAVED OBSERVATIONS';
  dataset = null; render(); byId('export-sample').disabled = true;
  document.querySelector('.workspace-foot span').textContent = sample ? 'Loading explicit mock sample' : 'Loading saved LXR report · no live market feed';
  byId('capture-time').textContent = '';
  document.querySelectorAll('mir-metric .metric-value').forEach(v => v.textContent = '—');
  byId('dataset-tag').textContent = 'LOADING';
  setBanner(sample ? 'LOADING MOCK SAMPLE' : 'LOADING SAVED LXR REPORT', 'No transaction execution is enabled.', 'loading');
  try {
    const response = await fetch(sample ? '/sample-data.json' : '/api/discovery', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Source unavailable');
    const result = await response.json();
    if (!Array.isArray(result.observations) || result.dataset !== (sample ? 'mock-sample' : 'saved-onchain')) throw new Error('Unexpected dataset');
    if (current !== generation) return;
    dataset = result;
    const count = result.observations.length;
    const metrics = [count, 'Unknown', new Set(result.observations.map(p => p.venue)).size, 0];
    document.querySelectorAll('mir-metric .metric-value').forEach((value, i) => value.textContent = String(metrics[i]));
    document.querySelectorAll('mir-metric small').forEach((value, i) => value.textContent =
      [sample ? 'Illustrative dataset' : 'In the latest saved scan', 'Costs and evidence incomplete', 'Distinct observation sources', 'Research only · not executable'][i]);
    document.querySelector('.workspace-foot span').textContent = sample ? 'Source: MOCK SAMPLE · not live' : 'Source: saved LXR scan · not a live market feed';
    if (sample) {
      byId('dataset-tag').textContent = 'MOCK SAMPLE';
      setBanner('MOCK SAMPLE — ILLUSTRATIVE DATA', 'Fictional interface figures. Not on-chain observations or trading results.', 'sample');
    } else if (!result.available) {
      byId('dataset-tag').textContent = 'NO REPORT';
      setBanner('NO SAVED REPORT AVAILABLE', 'Run the read-only discovery command locally, then reload this report. No sample data substituted.', 'unavailable');
    } else {
      byId('dataset-tag').textContent = result.freshness === 'recent-capture' ? 'SAVED REPORT' : 'STALE / REVIEW';
      setBanner(result.freshness === 'recent-capture' ? 'SAVED ON-CHAIN OBSERVATIONS — NOT LIVE' : 'STALE OR INVALID-TIME REPORT — NOT LIVE',
        'Captured data only. Gas, token safety and current execution conditions remain unverified.', result.freshness);
      byId('capture-time').textContent = `Captured: ${new Date(result.capturedAtMs).toLocaleString()} · block ${result.blockNumber}`;
    }
    byId('export-sample').disabled = false; render();
  } catch {
    if (current !== generation) return;
    dataset = null; byId('dataset-tag').textContent = 'UNAVAILABLE';
    setBanner('SOURCE UNAVAILABLE', 'The report could not be loaded or validated. No sample data substituted.', 'unavailable'); render();
  }
}
if (byId('pool-rows')) {
  // Standalone identity preview is explicitly MOCK SAMPLE.
  byId('dataset-mode').value = 'sample';
  if (new URLSearchParams(location.search).get('mode') === 'sample') byId('dataset-mode').value = 'sample';
  const selectView = view => {
    marketView = view;
    document.querySelectorAll('[data-market-view]').forEach(button => { const active = button.dataset.marketView === view; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    render();
  };
  document.querySelectorAll('[data-market-view]').forEach(button => button.addEventListener('click', () => selectView(button.dataset.marketView)));
  for (const id of ['sidebar-watchlist','header-watchlist','mobile-watchlist']) byId(id)?.addEventListener('click', () => { selectView('watchlist'); byId('observations').scrollIntoView({ block: 'start' }); });
  for (const id of ['source-health','header-source-health','mobile-more']) byId(id)?.addEventListener('click', () => { byId('health-detail').textContent = `${byId('source-banner').innerText} ${byId('capture-time').textContent}`; byId('health-dialog').showModal(); });
  byId('close-health')?.addEventListener('click', () => byId('health-dialog').close());
  byId('pool-search').placeholder = 'Search token or address…';
  byId('pool-search').addEventListener('input', render); byId('risk-filter').addEventListener('change', render);
  byId('dataset-mode').addEventListener('change', loadDataset); byId('refresh-report').addEventListener('click', loadDataset);
  byId('close-dialog').addEventListener('click', () => byId('evidence-dialog').close());
  byId('evidence-dialog').addEventListener('close', () => returnFocus?.focus());
  byId('export-sample').addEventListener('click', () => {
    if (!dataset) return;
    const output = { ...dataset, observations: filtered(), exportNotice: 'Unqualified research. No execution or known net profit.' };
    const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `mir-${dataset.dataset}-observations.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  customElements.whenDefined('mir-metric').then(loadDataset);
}
byId('sample-feedback')?.addEventListener('click', () => byId('component-feedback').textContent = 'Component preview only. No live action performed.');
byId('sample-secondary')?.addEventListener('click', () => byId('component-feedback').textContent = 'Evidence component: unknown means unverified.');
