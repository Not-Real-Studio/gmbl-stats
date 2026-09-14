# @gmbl/gm-stats — API

Ядро статистики слотов: словари распределений, правила агрегации, слияние шардов, DSL манифеста,
раскладка вкладки. Zero runtime deps, GAS-совместимо (чистые функции, JSON in/out, ES2020).

Спека: `docs/specs/gm-stats.md`. Эталон извлечения — sample-slot (`src/stats.js`,
`src/stats-grid.js`).

## Таргеты

| Артефакт | Кому |
|---|---|
| `dist/index.js` + `.d.ts` (ESM) | node: sim CLI, тесты, оркестрация |
| `dist/gm-stats.gas.js` | игра конкатенирует в свой GAS-бандл (плоский файл, ни import, ни export) |

GAS-бандл — IIFE `GmStats` плюс подвал `var X = GmStats.X;` на каждое публичное имя: в Apps
Script они становятся глобальными функциями, внутренние хелперы ядра остаются в замыкании и с
кодом игры не сталкиваются.

## 1. buckets — словари распределений

```js
STAT_LADDER                       // стандартная лестница (sample-app), кратности общей ставки
statBuckets()                     // [{label, lo, hi}] — lo включительно, hi исключительно
statBucketLabel(mult)             // '0x' | '(0,1)x' | '[100,125)x' | '[2000,+)x'
statFineLabels() / statFineLabel(mult)   // fine grid, шаг 50 до 3000+
makeBuckets(ladder?, fineStep?, fineMax?, cap?)   // свой словарь
makeBucketsFromSpec(spec, {cap?, fine?})          // словарь по строке лестницы из конфига игры
parseLadder(spec)                 // {ladder: number[], hasCap: boolean}
parseFine(spec)                   // {fineStep, fineMax} из 'step/max'
```

Словарь — `{ladder, fineStep, fineMax, cap, buckets(), bucketLabel(), fineLabels(), fineLabel()}`.

### 1.1. Лестница строкой (DSL)

Лестница Win Distribution — **данные конфига игры**, а не константа кода: заказчик калибрует ею
биг-вин, и у каждого слота сетка своя. Записывается одной строкой, токены через запятую, пробелы
игнорируются:

| Токен | Значение |
|---|---|
| `N` | одна граница (число > 0) |
| `a..b:s` | границы `a, a+s, a+2s, …, b` включительно |
| `cap` | маркер капа, допустим **только последним** токеном |

Сетка sample-app (шаг 10 между 20x и 100x — им калибруется биг-вин):

```
1,2,5,10,20..100:10,125,150,200,250,300,400,500,600,700,800,1000,1500,2000,2500,3000,4000,5000,10000,20000,cap
```

```js
const b = makeBucketsFromSpec(spec, { cap: 25000, fine: '50/3000' });
b.bucketLabel(95);        // '[90,100)x'
b.bucketLabel(25000);     // '25000x'   — точечный бакет капа
b.bucketLabel(25001);     // '>25000x'
```

Откуда игра взяла строку (вкладка документа, ТЗ, аргумент CLI) — ядро не знает и знать не должно.

- Пустая строка — стандартная лестница `STAT_LADDER` (пустой `fine` — `50/3000`).
- Голова всегда `0x`, затем `(0,L₀)x` по первой границе; тело — `[lo,hi)x` по парам.
- Хвост без капа — `[last,+)x`; с капом `C` — три бакета: `[last,C)x`, точечный `Cx` (`exact: true`,
  `lo === hi === C`) и `>Cx`. Попадание в кап ловится с относительным допуском `1e-9`: кратность
  приходит делением монет на ставку и с капом побитово не совпадает.
- `cap` в строке обязывает игру передать `opts.cap` — иначе throw (иначе кап молча схлопнулся бы
  в `[last,+)x`). `opts.cap` без `cap` в строке игнорируется.
- Всё, что похоже на молчаливую потерю границы, — громкая ошибка: шаг не делит диапазон
  (`20..95:10`), `b ≤ a`, невозрастающая пара, дубль на стыке сегментов (`100,100..200:25`),
  граница ≤ 0, `cap` не последним, `cap` на последней границе (пустой интервал `[C,C)x`).

## 2. accum — аккумуляция

```js
baseStats()          // {rounds, spins, wagered, sumWin, sumXSq, winRounds, maxWin, bkTotal, fineTotal}
accumulateBase(st, betWin, bet, buckets?)  // стандартная часть раунда (первая строка игровой accumulate)
bumpN(map, key, coins)      // +1 к n, +coins
bumpWin(map, key, coins)    // то же + счётчик выигрышных
addCoins(map, key, v)       // плоское map[key] += v
entry(map, key)             // {n, coins, wins} с нулями на отсутствующем ключе
```

Игра расширяет ядро спредом: `{ ...baseStats(), sumFg: 0, comboBase: {} }`.

## 3. merge — слияние шардов

```js
mergeStats(list, overrides?)   // overrides: { maxWin: 'max', maxSteps: 'max' }
```

Числа складываются, карты (в том числе вложенные `{n, coins, wins}`) сливаются поэлементно с
автосозданием ключей, строки берут первое непустое значение. Правила: `sum` (дефолт), `max`,
`min`, `first`. Ничего не мутирует.

## 4. manifest — DSL и секции

```js
const m = manifestBuilder({ bet });
m.row(label, agg, value?, of?, per?);   // порядок вызовов = порядок строк
m.section(title);
m.build();                              // Row[]
```

Правила `agg`: `section`, `text`, `date`, `sum`, `max`, `wavg`, `std`, `speed`, `noise`, `rtp`,
`share`, `pct`, `ratio`, `one_in`. Значение в колонке прогона несут только `text/date/sum/max/
wavg/std/speed/noise` — остальное считает агрегат.

Секции-генераторы:

```js
provenanceSection(m, st, prov)     // date/profile/mode/seed/config_hash + Rounds/Spins/Wagered/
                                   // Time/Speed/noise floor
rtpSection(m, st, sources, opts)   // sources: [{name, sum, label?, rtpLabel?}] или ГРУППЫ таких
                                   // списков; opts: {title?, wincap?: {hits}}
histSection(m, sets, buckets?, opts?)   // sets: [['Total', st.bkTotal], …] → N / coins / %RTP
fineSection(m, sets, labels?, opts?)
comboSection(m, config, sets, opts?)    // config: {symbols, paytable}; sets: [['BASE', st.comboBase], …]
payableSymbols(config)                  // [{id, name, lens}] по paytable
moments(st, bet)                        // {rounds, meanX, std, mean(sum)}
```

`rtpSection` группами: первая группа получает общие строки `E[win]/round` и `RTP % total`, каждая
группа печатает сначала блок своих `E[…]`, затем блок своих `RTP %`. Так собирается вёрстка вида
«base/FG/wincap, следом hot total/base/FG».

Лейблы-якоря экспортируются константами: `L_ROUNDS`, `L_SPINS`, `L_WAGERED`, `L_TIME`, `L_SPEED`,
`L_NOISE`, `L_EWAGER`, `L_EWIN`, `L_MEANX`, `L_STD`, `L_RTP`, `L_WIN_COUNT`, `L_HIT`,
`L_MAXWIN_COINS`, `L_MAXWIN_X`, `L_WINCAP_*`, `L_DATE/PROFILE/MODE/SEED/CONFIG_HASH`.

## 5. aggregate — агрегация кодом

```js
aggregateRows(columns)   // columns: Row[][] (колонки одного манифеста) → Row[] с посчитанным производным
rowsByLabel(rows)        // {label: value}
```

Средние взвешены по `Rounds` (не AVERAGE — у колонок разные N), STD собирается пулом.
Пустой прогон даёт `''`, а не нули. Промах по лейблу `of`/`per`, разные манифесты колонок,
неизвестное правило и цикл ссылок — исключения.

## 6. hash

```js
configHash(snapshot)                     // FNV-1a, 8 hex. Снапшот собирает ИГРА (game-specific)
statsConfigHash(adapter, config)         // хэш колонки: снапшот игры + раскладка манифеста
```

`statsConfigHash` хэширует `{game, dist}`: `game` — снапшот адаптера (или его готовый
`configHash`), `dist` — лейблы строк скелета манифеста (`adapter.manifest(adapter.newStats(),
config, {})`). Раскладка входит в хэш, потому что лейбл бакета — часть адресации сохранённых
колонок: смена лестницы Win Distribution не меняет ни одного поля конфига, но кладёт числа новой
сетки в колонку старой, и `statsAssertHomogeneous` этого не заметил бы. Побочка: **игра обязана
штамповать колонку тем же хэшем**, что считает ядро, — `configHash(снапшот)` напрямую в провенанс
писать больше нельзя.

## 7. grid — раскладка и формулы

```js
STAT_LAYOUT / makeLayout(overrides?)
statsColName(n) / statsLocalizeFormula(f, dialect)
statsAggregateFormulas(rows, shards, layout?)   // двойник aggregateRows на языке Sheets
statsStaleFormulas(rows, shards, layout?)       // инвалидация по хэшу конфига
statsSkeleton(rows, shards, dialect?, hash?, layout?)  // {labels, formulas, meta, header, stale}
statsShardValues(rows)
dashboardContent(rows, labels, layout?)         // labels: 'Лейбл' | ['Заголовок', 'Лейбл'] | null
distributionContent(rows, sets, buckets?, layout?)     // sets: [{name, per?}]
comboContent(rows, config, sets, layout?)
statsUpsertSummaryColumn(grid, {profile, mode}, rows, layout?)
statsPlanProfileActuals(grid, profile, values, layout?) / statsWriteProfileActuals(…)
statsFindLabelRow(grid, labelCol, label) / statsTrimTrailing(grid) / statsRectangular(grid)
```

Формулы пишутся с авторским разделителем `,` и локализуются под диалект документа
(`{formulaArg: ';'}`). Отсутствие лейбла в манифесте — всегда громкая ошибка.

## 8. port — SheetPort (Gas / Api / Mem)

Узкий синхронный транспорт; вся grid/шардинг-логика написана против него.

```js
port.ensureSheet(name)
port.size(name)                                   // {rows, cols} — использованный прямоугольник
port.read(name, row, col, numRows, numCols)       // формулы читаются ВЫЧИСЛЕННЫМИ
port.write(name, row, col, values)                // строка с '=' — формула (USER_ENTERED)
port.format(name, row, col, numRows, numCols, style)
port.setColWidths(name, colStart, widths)
port.clear(name)
port.flush()                                      // граница батча
portGrid(port, name)                              // вся вкладка одним чтением
```

`style` — ровно `{bg?, fontColor?, bold?, numberFormat?, border?}` (`border`: `'box' | 'all'`).
Больше полей не добавлять без второго реального потребителя.

| Порт | Импорт | Чем платит |
|---|---|---|
| `GasPort` | ядро/GAS-бандл | нужен живой `SpreadsheetApp` |
| `MemPort` | ядро | тесты; `new MemPort(initial, {evaluate})` — шов для вычислителя формул |
| `ApiPort` | `@gmbl/gm-stats/api` | сеть асинхронна: `await load([...])` → синхронная работа → `await commit()` |

```js
import { ApiPort } from '@gmbl/gm-stats/api';
const port = new ApiPort(spreadsheetId, { envPath });   // креды как у laptop:gsheets
await port.load(['stats']);            // значения вычисленные (UNFORMATTED_VALUE)
const rows = statsAggregateFromSheet(port);
port.write('stats', 1, 1, [['x']]);    // копится в буфере
await port.commit();                   // подряд идущие однотипные операции — одним запросом
await port.reload(['stats']);          // формулы отдают числа только после круга по сети
```

Квота Sheets ~60 запросов/мин: `commit()` склеивает буфер (values / clear / structural), на
429/503 — бэкофф и повтор. `loadGoogleCredentials(envPath?)` и `getAccessToken(creds)` доступны
отдельно. Порядок операций внутри буфера сохраняется.

## 9. table — шардинг поверх порта

Однописатель: `statsPrepareRun → N×statsComputeShard → statsWriteRun → statsCommitSummary →
statsWriteActuals`. Все функции берут `(port, adapter, …)` и работают одинаково в GAS и в node.

```js
statsPrepareRun(port, adapter, {profile, mode, shards, rounds, seed}, opts?)  // init вкладки
statsComputeShard(adapter, shard, {profile, mode, rounds, seed})              // ЧИСТЫЙ счётчик
statsWriteRun(port, adapter, results, params, opts?)                          // единственный писатель
statsCommitSummary(port, adapter, {profile, mode}, opts?)
statsWriteActuals(port, adapter, {profile, mode}, opts?)
statsCheckStale(port, adapter, profile, opts?) / statsClearTab(port, opts?)
statsAggregateFromSheet(port, opts?) / statsAssertHomogeneous(port, adapter, profile, mode, opts?)
statsReadParams(port, opts?) / statsManifestRow(rows, label, layout?) / statsSerialDate(ms?)
```

`opts`: `{layout?, sheets?: {stats, summary, profiles}, styles? | false, titles?, isDateKey?}`.
Оформление по умолчанию (`DEFAULT_STYLES`) делает вид вкладки кодифицированным — во всех слотах
одинаковым; `styles: false` — только значения.

`StatsAdapter` — контракт игры:

```js
{
  buildConfig(profile) -> {config, profileName, profiles?},
  newStats(), playRound(config, opts), accumulate(st, round, config),
  manifest(st, config, prov),
  snapshot(config) | configHash(config),
  modeOpts?(mode), roundSeed?(seed, i), dialect?(config),
  dashboard?, distSets?, distHeader?, comboSets?, comboConfig?(config),
  actuals?(byLabel, {mode, hash, date, profile}),
  defaults?: {rounds, shards, seed, modes}
}
```

Шард не пишет в шит вообще (параллельные исполнения GAS теряют записи, NOT-255) и не делает
врайтбек своими числами: и statSummary, и `actual_*` заполняются ПОВЕРХ агрегата. Колонки от
разных прогонов в агрегат не пускаются (`statsAssertHomogeneous`), протухшая колонка кричит.

Локи — снаружи: table-слой о рантайме не знает (в GAS их держит `gas/stats-tab.js`).

## 10. panel — сайдбар прогона (оркестрация)

```js
statsPanelHtml({title, prefix, modesHint?, defaults?: {rounds, shards, seed}, maxShards?})
statsPanelInfo(port, adapter, profile?, opts?)   // ответ {prefix}PanelInfo целиком
statsPanelLimits   // {maxShards, execLimitSec, shardBudgetSec, roundsPerSec, probeBaseRounds,
                   //  probeRounds, writeRetries, writeRetryMs}
```

Готовая страница сайдбара: `HtmlService.createHtmlOutput(oa2PanelHtml()).setTitle(…)`. Своего
`sidebar.html` у слота нет — оркестрация одна на все слоты.

Панель зовёт **ровно восемь** серверных функций слота, имена — из `prefix`
(`oa2` → `oa2PanelInfo`, `oa2PrepareRun`, `oa2ComputeShard`, `oa2WriteRun`, `oa2CommitSummary`,
`oa2WriteActuals`, `oa2CheckStale`, `oa2ClearStats`). Список закрыт тестом.

`{prefix}PanelInfo()` отдаёт `{profiles, modes, defaultRounds, defaultShards, defaultSeed,
configHash, buckets, lastRun, saved}`; `buckets` и `lastRun` — шапка состояния, без них она их
просто не показывает. Собирать это руками слоту не нужно — есть `statsPanelInfo`:

```js
function oa2PanelInfo() { return statsPanelInfo(oa2Port_(), oa2Adapter_()); }
```

Профили и хэш — из адаптера, дефолты — из `adapter.defaults`, `buckets` — из `adapter.buckets()`
(нет своей лестницы — бакеты ядра), `saved` — из строки параметров вкладки, `lastRun` — дата
provenance агрегата, `дд.мм.гггг`. Пустая вкладка не ошибка: панель открывают и до первого
прогона (`saved: null`, `lastRun: ''`).

`defaultRounds` — раундов **на колонку**: панель умножит на колонки и покажет итого.

**Однописатель (NOT-255).** Колонки считаются в K параллельных `google.script.run`
(`ComputeShard` — чистый счёт, шита не касается), готовые складываются в очередь, и `WriteRun`
пишет накопленное **по одному вызову за раз**. Параллельные исполнения, пишущие один шит, теряют
записи даже под локом; ни `LockService`, ни запись из шарда решением не являются. Записанное
видно в таблице по ходу прогона — прерванный прогон теряет только то, что было в полёте.
Провал записи — три попытки с паузой 2 с, дальше внятная ошибка с числом незаписанных колонок.

**Потолок одновременных исполнений** — `maxShards` (дефолт 30, у Google порядка 30 на
пользователя): в полёте не больше, освободилось — стартует следующая колонка. Колонок при этом
может быть сколько угодно (боевой прогон — 50).

**Итого раундов.** Поле — сумма на прогон, под ним раунды на колонку = итого / колонок; серверные
функции получают раунды **на колонку**. Боевой объём меряют суммой: «20M на 50 колонок» — это
20 млн всего.

**Оценка времени колонки.** Колонка — одно GAS-исполнение с лимитом `execLimitSec`. Кнопка
«Замер скорости» гоняет два пробных `ComputeShard` разного объёма: разность даёт раундов/с,
накладные (сборка конфига, манифест) вычитаются отдельно. Оценка выше `shardBudgetSec` — Run
гаснет. До замера считается по `roundsPerSec`. Все пороги — в `statsPanelLimits`, в HTML своих
чисел нет.

## Границы

`ApiPort` НЕ заменяет GAS-симуляцию: ферма (50 шардов × 20M ≈ 1B раундов за ~2 минуты) остаётся
основным вычислителем массовых прогонов. ApiPort — чтение результатов, автоматизация, мелкие
прикидки, тесты. Со `smir` (TOON-зеркало) он тоже не пересекается: smir — версионируемая
структурная синхронизация групп вкладок с git-историей, ApiPort — живой точечный доступ.

Правило дома: механизм переезжает в ядро после **второго** использования, не раньше.
