const byId = id => document.getElementById(id);
const paragraph = (node, text) => { const p = document.createElement('p'); p.textContent = text; node.append(p); };
const evidence = (node, label, id) => {
  const details = document.createElement('details'), summary = document.createElement('summary');
  summary.textContent = label; details.append(summary); paragraph(details, id); node.append(details);
};
async function refresh() {
  byId('reload').disabled = true;
  byId('datasets').replaceChildren(); byId('experiments').replaceChildren();
  byId('status').textContent = 'جارٍ التحقق من البيانات وإعادة الحساب…';
  try {
    const responses = await Promise.all(['datasets', 'experiments'].map(type => fetch(`/api/lab/${type}`, { cache: 'no-store' })));
    if (responses.some(r => !r.ok)) throw new Error('unavailable');
    const [datasets, experiments] = await Promise.all(responses.map(r => r.json()));
    if (!Array.isArray(datasets.items) || !Array.isArray(experiments.items)) throw new Error('invalid');
    for (const d of datasets.items) {
      const card = document.createElement('article');
      paragraph(card, `${d.asset} — ${d.intervals} فترة تمويل`);
      paragraph(card, `${new Date(d.startMs).toISOString()} → ${new Date(d.endMs).toISOString()}`);
      paragraph(card, `المصدر: ${d.source}`); evidence(card, 'هوية البيانات', d.id);
      byId('datasets').append(card);
    }
    for (const e of experiments.items) {
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
    byId('status').textContent = 'الأدلة غير متاحة أو تعذر التحقق منها. لم تُستخدم بيانات بديلة.';
  } finally { byId('reload').disabled = false; }
}
byId('reload').addEventListener('click', refresh); refresh();
