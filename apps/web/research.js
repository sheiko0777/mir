/* Independent saved watchlist research; no collection, persistence or execution from this page. */
(() => {
  const root = document.getElementById('research-panel');
  if (!root) return;
  const find = id => document.getElementById(id);
  const selector = find('dataset-mode');
  if (new URLSearchParams(location.search).get('mode') === 'sample') selector.value = 'sample';
  const statuses = { 'positive-under-assumptions': 'Positive scenario · evidence required',
    'no-positive-scenario': 'No positive tested scenario', 'no-costed-candidate': 'No costed candidate' };
  const venues = { 'uniswap-v2': 'Uniswap V2', 'sushiswap-v2': 'SushiSwap V2' };
  const tasks = { CHECK_TOKEN_BEHAVIOR: 'Check token behavior', VALIDATE_GAS_ASSUMPTIONS: 'Validate assumed gas',
    PAPER_REPLAY_REQUIRED: 'Independent paper replay needed', VALUE_GAS: 'Establish gas assumptions',
    REPLAY_SIZED_QUOTES: 'Replay sized quotes', REVIEW_SIZE_CONSTRAINTS: 'Review size constraints',
    REFRESH_RESEARCH: 'Collect a new research snapshot', REVIEW_COST_ASSUMPTIONS: 'Review cost assumptions' };
  let state = null, page = 0, generation = 0;
  const pageSize = 20;
  function amount(value, decimals, label, compact = false) {
    if (value === null) return 'Unknown';
    if (typeof value !== 'string' || !/^-?\d{1,128}$/.test(value) || ![6, 18].includes(decimals)) throw new Error('Invalid research amount');
    const negative = value.startsWith('-');
    let absolute = negative ? value.slice(1) : value, precision = decimals, approximate = false;
    if (compact && decimals > 8) {
      const scale = 10n ** BigInt(decimals - 8);
      approximate = BigInt(absolute) % scale !== 0n;
      absolute = ((BigInt(absolute) + scale / 2n) / scale).toString(); precision = 8;
    }
    const digits = absolute.padStart(precision + 1, '0');
    const fraction = digits.slice(-precision).replace(/0+$/, '');
    return `${approximate ? '≈ ' : ''}${negative && BigInt(absolute) !== 0n ? '−' : ''}${digits.slice(0, -precision)}${fraction ? '.' + fraction : ''} ${label}`;
  }
  function empty(message) {
    state = null; page = 0; root.dataset.state = 'unavailable';
    find('research-status').textContent = message;
    find('research-source').textContent = 'No live feed or automatic sample substitution.';
    find('research-summary').replaceChildren(); find('research-rows').replaceChildren();
    find('research-review').replaceChildren(); find('research-assumptions').textContent = '';
    find('research-pagination').hidden = true; find('research-table').hidden = true;
  }
  function metric(label, value, exact = value) {
    const article = document.createElement('article'), title = document.createElement('span'), body = document.createElement('strong');
    title.textContent = label; body.textContent = value; body.title = exact; article.append(title, body); return article;
  }
  function renderPage() {
    const rows = find('research-rows'); rows.replaceChildren();
    const analysis = state.analysis;
    for (const candidate of analysis.candidates.slice(page * pageSize, (page + 1) * pageSize)) {
      const tr = document.createElement('tr');
      const values = [amount(candidate.inputQuote, analysis.quoteDecimals, state.quoteLabel),
        `${venues[candidate.buyVenue]} → ${venues[candidate.sellVenue]}`,
        amount(candidate.grossAfterPoolFeesQuote, analysis.quoteDecimals, state.quoteLabel),
        amount(candidate.gasQuoteScenario, analysis.quoteDecimals, state.quoteLabel),
        amount(candidate.bufferQuoteScenario, analysis.quoteDecimals, state.quoteLabel),
        amount(candidate.scenarioNetQuote, analysis.quoteDecimals, state.quoteLabel),
        candidate.withinResearchConstraints ? 'Unqualified · evidence missing' : 'Blocked by research constraints'];
      values.forEach((value, i) => {
        const td = document.createElement('td'); td.textContent = value;
        if (i === 6) {
          const details = document.createElement('details'), summary = document.createElement('summary'), reasonList = document.createElement('ul');
          summary.textContent = value;
          for (const reason of candidate.reasons) { const li = document.createElement('li'); li.textContent = reason.replaceAll('_', ' ').toLowerCase(); reasonList.append(li); }
          details.append(summary, reasonList); td.replaceChildren(details); td.className = 'research-row-review';
        }
        if ([0, 2, 3, 4, 5].includes(i)) td.className = 'research-number';
        if (i === 5 && candidate.scenarioNetQuote !== null) td.dataset.sign = BigInt(candidate.scenarioNetQuote) < 0n ? 'negative' : 'neutral';
        tr.append(td);
      });
      tr.title = candidate.reasons.join(' · '); rows.append(tr);
    }
    const pages = Math.max(1, Math.ceil(analysis.candidates.length / pageSize));
    find('research-page').textContent = `${analysis.candidates.length} candidates · page ${page + 1} of ${pages}`;
    find('research-prev').disabled = page === 0; find('research-next').disabled = page + 1 === pages;
  }
  function render(result) {
    const analysis = result.analysis, preview = result.agentPreview;
    if (result.dataset !== 'saved-research' || !result.available || !analysis ||
        analysis.mode !== 'costed-size-research' || !Array.isArray(analysis.candidates) || analysis.candidates.length > 5760 ||
        analysis.netProfitKnown !== false || analysis.qualifiedOpportunities !== 0 ||
        !preview || preview.previewOnly !== true || !Array.isArray(preview.decisions) ||
        analysis.candidates.some(c => c.qualified !== false || c.netQuote !== null || !Array.isArray(c.reasons))) throw new Error('Unexpected research response');
    state = result; page = 0; root.dataset.state = result.freshness;
    find('research-status').textContent = result.freshness === 'recent-capture' ? statuses[analysis.status] ?? 'Saved research' : 'Stale or invalid-time research · no current best';
    find('research-source').textContent = `Independent watchlist snapshot · block ${result.blockNumber} · captured ${new Date(result.capturedAtMs).toLocaleString()} · ${result.blockHash}`;
    find('research-summary').replaceChildren(metric('Tested sizes', analysis.policy.inputsQuote.length),
      metric('Best tested scenario · assumed costs', analysis.bestScenario ?
        amount(analysis.bestScenario.scenarioNetQuote, analysis.quoteDecimals, result.quoteLabel, true) : 'None / unknown',
        analysis.bestScenario ? amount(analysis.bestScenario.scenarioNetQuote, analysis.quoteDecimals, result.quoteLabel) : 'No eligible tested scenario'),
      metric('Actual net profit', 'Unknown'), metric('Qualified routes', '0'));
    const cost = analysis.costScenario;
    find('research-assumptions').textContent = cost?.available ?
      `Assumptions: ${cost.assumptions.gasUnits} gas units; ${cost.assumptions.priorityFeeWei} wei priority fee; ${analysis.policy.bufferBps} bps input buffer. Gas units are not measured. Best means best of the tested grid.` :
      'Gas or conversion evidence is missing. Scenario net remains unknown; zero cost is not substituted.';
    const review = find('research-review'); review.replaceChildren();
    const heading = document.createElement('h3'); heading.textContent = 'Agent evidence review · preview'; review.append(heading);
    const message = document.createElement('p');
    message.textContent = preview.status === 'blocked' ? 'Review blocked: ' + preview.reasons.join(' · ') :
      'Read-only review. This page does not save decisions or create paper fills.'; review.append(message);
    for (const decision of preview.decisions) {
      const ul = document.createElement('ul');
      for (const task of decision.tasks) { const li = document.createElement('li'); li.textContent = tasks[task] ?? task; ul.append(li); }
      review.append(ul);
      const details = document.createElement('details'), summary = document.createElement('summary'), reasons = document.createElement('p');
      summary.textContent = 'Why the route remains unqualified'; reasons.textContent = decision.reasons.join(' · ');
      details.append(summary, reasons); review.append(details);
    }
    find('research-table').hidden = analysis.candidates.length === 0;
    find('research-pagination').hidden = analysis.candidates.length === 0;
    renderPage();
  }
  async function load() {
    const current = ++generation;
    empty(selector.value === 'sample' ? 'Research is paused while the mock dataset is selected' : 'Loading saved watchlist research…');
    if (selector.value === 'sample') return;
    try {
      const response = await fetch('/api/research', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('Research unavailable');
      const result = await response.json();
      if (current !== generation) return;
      if (result.available === false && result.dataset === 'saved-research') {
        empty('No committed research report · collect research locally, then reload'); return;
      }
      render(result);
    } catch { if (current === generation) empty('Research unavailable or invalid · prior figures cleared'); }
  }
  find('research-reload').addEventListener('click', load);
  find('research-prev').addEventListener('click', () => { page--; renderPage(); });
  find('research-next').addEventListener('click', () => { page++; renderPage(); });
  selector.addEventListener('change', load); find('refresh-report').addEventListener('click', load);
  load();
})();
