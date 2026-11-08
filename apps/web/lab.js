const byId = id => document.getElementById(id);
const paragraph = (node, text) => { const p = document.createElement('p'); p.textContent = text; node.append(p); };
const evidence = (node, label, id) => {
  const details = document.createElement('details'), summary = document.createElement('summary');
  summary.textContent = label; details.append(summary); paragraph(details, id); node.append(details);
};
async function refresh() {
  byId('reload').disabled = true;
  byId('datasets').replaceChildren(); byId('experiments').replaceChildren();
  byId('bots').replaceChildren();
  byId('status').textContent = 'جارٍ التحقق من البيانات وإعادة الحساب…';
  try {
    const responses = await Promise.all(['/api/lab/datasets', '/api/lab/experiments', '/api/bots'].map(url => fetch(url, { cache: 'no-store' })));
    if (responses.some(r => !r.ok)) throw new Error('unavailable');
    const [datasets, experiments, bots] = await Promise.all(responses.map(r => r.json()));
    if (!Array.isArray(datasets.items) || !Array.isArray(experiments.items) || !Array.isArray(bots.bots) || !Array.isArray(bots.tasks)) throw new Error('invalid');
    const states = { 'research-evidence-available': 'أدلة بحث محفوظة', 'awaiting-data': 'بانتظار بيانات', 'awaiting-integration': 'بانتظار استكمال الدمج',
      'protocol-ineligible': 'العقد المحدد غير مؤهل للمطالبة عند البلوك المحفوظ' };
    const implementations = { 'integrated-analysis': 'تحليل مدمج', 'adapter-available': 'موصّل أولي متاح', 'source-reviewed': 'تم فحص المصدر' };
    const taskNames = { 'review-route-evidence': 'مراجعة أدلة المسارات', 'collect-pinned-pools': 'جمع حالة البوولز',
      'review-depth-and-hedge-identity': 'مراجعة العمق وهوية التحوّط', 'collect-spot-perp-depth': 'جمع عمق طرفي السوق',
      'freeze-prospective-carry-policy': 'تثبيت سياسة تجربة التمويل', 'collect-funding-history': 'جمع تاريخ التمويل',
      'prepare-offline-model-and-context': 'تجهيز نموذج Kronos وبياناته', 'review-public-feed-adapter': 'مراجعة موصّل أسواق التوقعات',
      'review-protocol-claims': 'فحص مكافآت البروتوكول وتكلفة اقتناصها',
      'select-active-protocol': 'اختيار هدف نشط والتحقق منه قبل استكمال البحث' };
    for (const bot of bots.bots) {
      const card = document.createElement('article');
      const heading = document.createElement('h3'); heading.textContent = bot.name; card.append(heading);
      paragraph(card, bot.purpose);
      paragraph(card, `${implementations[bot.implementation]} — ${states[bot.status]}`);
      paragraph(card, `مراجع الأدلة ${bot.evidenceIds.length} — صافي الربح غير مثبت`);
      if (bot.worker) {
        const worker = bot.worker;
        const labels = { 'awaiting-data': 'بانتظار التقاط بيانات', 'source-unavailable': 'المصدر العام غير متاح',
          'rejected-evidence': 'القراءة مرفوضة بسبب التوقيت — لا توجد فرصة معتمدة',
          'illustrative-only': 'عينة وهمية للاختبار فقط', 'stale-evidence': 'بيانات قديمة — لا تمثل فرصة حالية',
          'read-only-evidence': 'قراءة حديثة — التنفيذ والربح غير مثبتين' };
        paragraph(card, labels[worker.status] ?? 'حالة غير معتمدة');
        if (worker.viability) {
          const drawStates = { unverified: 'نافذة المطالبة لم تُفحص', shutdown: 'العقد المحدد متوقف عند البلوك المحفوظ — لا مطالبات معتمدة',
            'no-awarded-draw': 'لا يوجد سحب مُعلن', 'claim-window-expired': 'نافذة المطالبة منتهية',
            'claim-window-open': 'نافذة المطالبة مفتوحة عند البلوك المحفوظ؛ التنفيذ غير مثبت' };
          paragraph(card, drawStates[worker.viability.status] ?? 'حالة السحب غير معتمدة');
        }
        if (worker.coverage) paragraph(card, `تم فحص ${worker.coverage.seedsChecked} ترشيحات محدودة؛ التغطية ليست شاملة.`);
        if (worker.coverage?.discovery) {
          const d = worker.coverage.discovery;
          paragraph(card, `اكتشاف من ${d.eventsObserved} أحداث سابقة: ${d.addedSeeds} ترشيحات إضافية بين بلوك ${d.fromBlock} و${d.toBlock}. عينة من فائزين سابقين وليست كل الحسابات المؤهلة.`);
        }
        for (const batch of worker.batches) {
          paragraph(card, `Tier ${batch.tier} — ${batch.claims} مطالبات — مكافأة مشروطة ${batch.quotedRewardAtomic} بوحدة WETH wei`);
          paragraph(card, batch.scenario.netAtomic === null ? 'التكاليف ناقصة؛ الصافي مجهول.' :
            `سيناريو بافتراض نجاح المطالبات: ${batch.scenario.netAtomic}؛ مع مضاعفة التكاليف: ${batch.scenario.doubledCostNetAtomic}. ليس ربحًا محققًا.`);
        }
      }
      for (const next of bots.tasks.filter(task => task.botId === bot.id)) {
        evidence(card, taskNames[next.kind], next.reasons.join(' · '));
      }
      byId('bots').append(card);
    }
    for (const d of [...datasets.items].sort((a, b) => b.capturedAtMs - a.capturedAtMs)) {
      const card = document.createElement('article');
      if (d.kind === 'market-snapshot') {
        paragraph(card, 'لقطة سوق عامة — قراءة فقط');
        paragraph(card, new Date(d.capturedAtMs).toISOString());
        for (const market of d.markets) paragraph(card, `${market.symbol} — ${market.spot ? 'spot' : 'perpetual'} — ID: ${market.id}`);
        paragraph(card, `${d.quality.requests} طلبات — زمن الاستجابة p50: ${d.quality.latencyP50Ms} ms، p95: ${d.quality.latencyP95Ms} ms`);
        for (const book of d.quality.books) paragraph(card, `${book.coin}: ${book.reason ? `مرفوضة — ${book.reason}` : 'اجتازت فحص الهوية والتوقيت والبنية'}؛ عمر اللقطة: ${book.ageMs ?? 'مجهول'} ms`);
        for (const pair of d.quality.candidatePairs ?? []) paragraph(card, `مجموعة رموز ${pair.candidateSymbolGroup}: فرق توقيت المصدر بين الطرفين ${pair.sourceSkewMs ?? 'مجهول'} ms؛ تكافؤ التحوّط غير مثبت.`);
        paragraph(card, d.quality.captureMode === 'parallel-2' ? 'التقاط بطلبين متوازيين؛ تزامن حالة السوق غير مثبت.' : 'التقاط متتابع؛ اللقطات ليست متزامنة.');
        paragraph(card, 'تكافؤ الأصل والتكاليف غير مثبتين؛ صافي الربح مجهول.');
        evidence(card, 'هوية البيانات', d.id); byId('datasets').append(card); continue;
      }
      paragraph(card, `${d.asset} — ${d.intervals} فترة تمويل`);
      paragraph(card, `${new Date(d.startMs).toISOString()} → ${new Date(d.endMs).toISOString()}`);
      paragraph(card, `المصدر: ${d.source}`); evidence(card, 'هوية البيانات', d.id);
      byId('datasets').append(card);
    }
    for (const e of [...experiments.items].sort((a, b) => a.asset.localeCompare(b.asset) || b.result.intervals - a.result.intervals || Number(a.experiment.capitalUsd) - Number(b.experiment.capitalUsd))) {
      const card = document.createElement('article');
      paragraph(card, `${e.asset} — رأس مال افتراضي ${e.experiment.capitalUsd} USD`);
      paragraph(card, `${e.result.intervals} ساعة — تشخيص تاريخي`);
      paragraph(card, 'القرار: أدلة غير كافية. صافي الربح والعائد والتراجع: غير محسوبة.');
      paragraph(card, `التمويل المطبع: ${Number(e.result.normalizedShortFundingBps).toFixed(4)} نقطة أساس، وليس ربحًا صافيًا.`);
      paragraph(card, 'ينقص: أسعار spot وperp المتزامنة، تكاليف التنفيذ، الضمان، واختبار مستقل ومتابعة أمامية.');
      evidence(card, 'هوية التجربة', e.id); byId('experiments').append(card);
    }
    byId('status').textContent = datasets.items.length ? 'تم التحقق وإعادة الحساب. النتائج تاريخية وليست توصيات تنفيذ.' : 'لا توجد بيانات مختبر مستوردة بعد.';
  } catch {
    byId('datasets').replaceChildren(); byId('experiments').replaceChildren();
    byId('bots').replaceChildren();
    byId('status').textContent = 'الأدلة غير متاحة أو تعذر التحقق منها. لم تُستخدم بيانات بديلة.';
  } finally { byId('reload').disabled = false; }
}
byId('reload').addEventListener('click', refresh); refresh();
