# خدمات MIR — دليل التشغيل

الخدمات عمال Python للقراءة فقط تحت `services/`. كل عامل يكتب تقرير JSON بشكل موحد، وخادم MIR
يتحقق منه ويعرضه. لا توقيع، لا إرسال معاملات، لا مفاتيح خاصة.
الخطة الكاملة: [خطة توسيع الخدمات](SERVICES-EXPANSION-PLAN.md).

## المسار

```
عامل Python  ──►  data/services/<service>/latest.json  ──►  خادم MIR  ──►  GET /api/services
                  data/services/<service>/last-attempt.json (عند فشل المصدر)
```

`data/` خارج Git. الخادم لا يستبدل تقريرًا مفقودًا أو تالفًا ببيانات عينة.

## شكل التقرير الموحد

المصدر: `services/common/report.py`. المدقق المقابل في الخادم: `apps/server/services.mjs`.
الاثنان يُختبران على الأمثلة نفسها في `test/fixtures/service-reports.json`.

| الحقل | المعنى |
|---|---|
| `schemaVersion` | 1 |
| `service` | معرّف الخدمة: حروف صغيرة وأرقام وشرطات، ويطابق اسم المجلد |
| `title` | اسم مقروء |
| `status` | `ok` أو `incomplete` أو `source-unavailable` |
| `provenance` | `CHAIN_OBSERVED` أو `PINNED_FIXTURE` أو `FORK_SIMULATED` أو `ASSUMED_INPUT` |
| `generatedAt` | وقت التوليد UTC، مثل `2026-11-15T12:00:00Z` |
| `staleAfterSeconds` | بعدها يعرض الخادم التقرير `stale` |
| `executionEnabled` | يجب أن يكون `false`؛ أي قيمة أخرى ترفض التقرير |
| `summary` | قيم بسيطة للبطاقة في الواجهة |
| `caveats` | حدود التقرير، نصوص |
| `data` | محتوى الخدمة الكامل |

## المسارات في الخادم

- `GET /api/services`: قائمة الخدمات مع الحالة، المصدر، عمر البيانات (`fresh` / `stale`)، والملخص.
  تقرير تالف يظهر `status: "invalid"` بلا بيانات. محاولة فاشلة أحدث من آخر تقرير تظهر في `lastAttempt`.
- `GET /api/services/<id>`: التقرير الكامل. 404 إن لم يوجد، و503 إن فشل التحقق.

## الخدمة الأولى: مراقب حد الـ 500k (Launchpad)

`services/launchpad_watch.py`. من مصدر عقد Uniswap (`BaseClaimRecipient.claim`
و`BuybackAndBurnClaimRecipient`): من يستدعي `claim` يستلم الرصيد المنسوب من العملة الأصلية ومن
توكن المركز، ثم يُسحب منه `minCurrency1BurnAmount` (افتراضيًا 500,000 توكن) ويُحرق. إذن:

```
العجز = الحد − رصيد التوكن المنسوب
```

عند عجز صفر لا يحتاج المنفذ مخزون توكن. الأداة تحسب لكل `tokenId` سرعة التراكم والوقت المتوقع
للوصول للحد، وتعد من يفوز بالـ claims.

| الحالة | المعنى |
|---|---|
| `READY_NO_INVENTORY` | الرصيد المنسوب ≥ الحد الآن. ليس ادعاء ربح؛ ما زال مطلوبًا الغاز والمنافسة ومحاكاة fork |
| `APPROACHING` | سيصل للحد خلال `--horizon-days` بمعدل `--lookback-days` |
| `ACCRUING` | يتراكم، والوقت المتوقع أبعد من الأفق |
| `DORMANT` | لا تراكم توكن في نافذة المعدل |
| `RATE_UNKNOWN` | المصدر لم يعطِ أوقات البلوكات؛ المعدل مجهول وليس صفرًا |

```bash
# من ملف logs محفوظ (JSON-RPC أو Blockscout v2)؛ يوسم PINNED_FIXTURE
python -m services.launchpad_watch --logs saved_logs.json

# من Blockscout مباشرة؛ يوسم CHAIN_OBSERVED
python -m services.launchpad_watch --blockscout

# من RPC (يتحقق من chain id أولًا)
python -m services.launchpad_watch --rpc-url <RPC> --from-block N --to-block M

# تعداد المنافسة: ملف يربط tx_hash -> {"from": EOA, "to": executor}
python -m services.launchpad_watch --logs saved_logs.json --tx-meta tx_meta.json
```

عند رفض المصدر أو صفحة تحدٍّ (Cloudflare): يطبع `SOURCE_UNAVAILABLE`، يخرج بكود 2، يكتب
`last-attempt.json` فقط، ولا يمس آخر تقرير سليم. لا نحاول تجاوز التحدي. سبب الفشل لا يُحفظ نصًا
حتى لا يتسرب مفتاح ضمن رابط RPC.

### حدود معروفة

- الرصيد المنسوب لا يشمل الرسوم الباقية داخل مركز v4، فالعجز حد أعلى.
- المعدل يفترض استمرار تدفق نافذة المعدل؛ رسوم توكنات الإطلاق متقطعة.
- الحد 500,000 × 1e18 افتراض؛ يجب قراءة `minCurrency1BurnAmount` من العقد المنشور.
- النافذة يجب أن تبدأ من نشر العقد؛ إذا ظهر `Claimed` أكبر من المستلم ترفض الأداة الحساب.
- chain id لشبكة Robinhood في `services/common/networks.py` غير متحقق منه.

### حالة التحقق (15 نوفمبر 2026)

- الاختبارات على logs اصطناعية مبنية من الـ ABI الحقيقي؛ keccak مطابق للمتجهات المعروفة.
- لا نتائج حية بعد: من بيئة التطوير، Blockscout لـ Arc وRobinhood أعاد HTTP 403، وRPC الخاص بـ Arc
  لم يتصل. يلزم تشغيله من جهاز أو RPC يصل للشبكة.

## الخدمة الثانية: حارس المراكز (Liquity V2 WETH)

`services/guardian/`. يجيب عن سؤال واحد لكل مركز: كم يمكن أن يهبط سعر الضمان قبل أن يسمح
البروتوكول بالتصفية؟

```
المسافة = (السعر − سعر التصفية) / السعر   (نقاط أساس)
```

- `risk.py`: حساب بأعداد صحيحة فقط. مدخلان: نسبة ضمان دنيا (Liquity: تصفية عند ICR < MCR)، أو
  health factor (Aave: تصفية عند HF < 1). سياسة التنبيه في `decide_alert`.
- `liquity.py`: يقرأ لقطة محفوظة من `tools/research/liquity_screen.py` ويكتب تقرير الخدمة.
  لا اتصال بالشبكة، ولا يستورد أداة اللقطة، فطبقة الخدمات بلا مكتبات خارجية.

| المستوى | المسافة للتصفية (الافتراضي) |
|---|---|
| `SAFE` | أكثر من 25% |
| `WATCH` | 25% أو أقل |
| `DANGER` | 10% أو أقل |
| `CRITICAL` | 3% أو أقل، ويشمل الوقوف على الحد بالضبط |
| `LIQUIDATABLE` | قاعدة البروتوكول نفسها تسمح بالتصفية الآن |
| `UNKNOWN` | سعر غير صالح أو بيانات أقدم من 15 دقيقة. **لا يتحول أبدًا إلى آمن** |
| `NO_DEBT` | لا دين |

سياسة التنبيه:
- الصعود لمستوى أخطر: تنبيه فوري.
- النزول لمستوى أقل: يحتاج تجاوز الحد بهامش (hysteresis، افتراضيًا 1%) حتى لا يتذبذب التنبيه.
- البقاء في `DANGER` أو أسوأ: تذكير كل 6 ساعات (خطر) أو كل ساعة (حرج وقابل للتصفية).
- الرجوع لآمن: رسالة تعافٍ واحدة. انقطاع البيانات: رسالة واحدة "البيانات غير محدثة"، لا "آمن".

```bash
# من لقطة Liquity محفوظة؛ يوسم PINNED_FIXTURE
python -m services.guardian.liquity --screen data/liquity-screen/<id>.json
# مراكز محددة فقط؛ المركز غير الموجود في العينة يظهر "ليس في العينة"، وليس "آمن"
python -m services.guardian.liquity --screen <file> --watch 123,456
```

حدود: العينة أول 128 مركزًا في القائمة المرتبة (المراكز zombie مستبعدة)، والسعر قد يقفز بين
قراءتين، والـ redemptions لا تُحسب. التنبيه معلومة وليس نصيحة مالية ولا ضمانًا بأنه يسبق التصفية.
بوت تليجرام والقراءة الحية من الشبكة لم يُبنيا بعد؛ يحتاجان RPC وتوكن البوت.

## الاختبارات

```bash
npm run test:services     # عمال Python
npm test                  # الخادم، ومنها test/services.test.mjs
```

صفحة `lab.html` تعرض بطاقة لكل خدمة من `GET /api/services`: الحالة، المصدر، عمر البيانات، الملخص،
وحدود التقرير.
