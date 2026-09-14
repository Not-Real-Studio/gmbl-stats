// table-слой поверх MemPort: init → шарды → агрегат → statSummary → врайтбек.
//
// Это тот самый сценарий №1 спеки: вся grid/шардинг-логика проверяется без живого GAS. MemPort
// с вычислителем формул ведёт себя как настоящий шит (агрегатная колонка отдаёт числа), поэтому
// проверяется не пересказ, а ровно то, что уедет в документ: значения, формулы и оформление.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemPort, STAT_LAYOUT, aggregateRows, histSection, makeBucketsFromSpec, manifestBuilder, portGrid,
  provenanceSection, rowsByLabel, statsAggregateFromSheet, statsAssertHomogeneous, statsCheckStale,
  statsClearTab, statsCommitSummary, statsComputeShard, statsConfigHash, statsManifestRow,
  statsPrepareRun, statsReadParams, statsWriteActuals, statsWriteRun
} from '../src/index.ts';
import type { BaseStats, Cell, Grid, ShardResult, StatsAdapter } from '../src/index.ts';
import { ADAPTER, BET, adapterWithBuckets, buildConfig } from './_fake-game.ts';
import { sheetEvaluator } from './_sheet-eval.ts';

const L = STAT_LAYOUT.stats;
const SHARDS = 3;
const ROUNDS = 400;
const SEED = 4242;
const PARAMS = { profile: 'rtp96', mode: 'base', rounds: ROUNDS, seed: SEED, shards: SHARDS };

function profilesGrid(): Grid {
  return [
    ['', '', '', '', ''],
    ['', 'var_name', 'comment', 'rtp96', 'rtp94'],
    ['', 'target_rtp', 'цель', 96, 94],
    ['', 'actual_rtp', '', '', ''],
    ['', 'actual_std', '', '', ''],
    ['', 'actual_date', '', '', ''],
    ['', 'actual_hash', '', '', ''],
    // формула-сосед: врайтбек обязан её пережить (в живом документе тут схождение по допуску)
    ['', 'converged', 'схождение', '=IF(ABS(D4-D3)=0,"ok","нет")', '']
  ];
}

function newPort(): MemPort {
  return new MemPort(
    { stats: [], statSummary: [], profiles: profilesGrid() },
    { evaluate: sheetEvaluator }
  );
}

function manifestRows(): ReturnType<typeof ADAPTER.manifest> {
  return ADAPTER.manifest(ADAPTER.newStats(), buildConfig('rtp96').config, {});
}

function runAll(port: MemPort, mode = 'base'): ShardResult[] {
  statsPrepareRun(port, ADAPTER, { ...PARAMS, mode });
  const results: ShardResult[] = [];
  for (let s = 1; s <= SHARDS; s++) {
    results.push(statsComputeShard(ADAPTER, s, { ...PARAMS, mode }));
  }
  statsWriteRun(port, ADAPTER, results, { ...PARAMS, mode });
  return results;
}

// --- init ------------------------------------------------------------------------------------

test('prepareRun: параметры, витрина, сырьё — вкладка собрана целиком', () => {
  const port = newPort();
  const init = statsPrepareRun(port, ADAPTER, PARAMS);
  const rows = manifestRows();
  assert.equal(init.rows, rows.length);
  assert.deepEqual({ shards: init.shards, profile: init.profile, mode: init.mode },
    { shards: SHARDS, profile: 'rtp96', mode: 'base' });

  // строка параметров читается обратно (панель показывает последний прогон без своей памяти)
  assert.deepEqual(statsReadParams(port), { profile: 'rtp96', mode: 'base', seed: SEED, spins: ROUNDS, shards: SHARDS });

  // витрина: заголовки блоков и первые строки dashboard
  const raw = port.snapshot('stats').values;
  const at = (r: number, c: number): Cell => ((raw[r - 1] || []) as Cell[])[c - 1];
  assert.equal(at(STAT_LAYOUT.dash.headerRow, 1), '— Dashboard —');
  assert.equal(at(STAT_LAYOUT.dash.firstRow, 1), 'RTP %');
  assert.equal(at(STAT_LAYOUT.dash.firstRow, L.aggCol),
    '=C' + statsManifestRow(rows, 'RTP % total'), 'ячейка витрины — ссылка на агрегат сырья');
  assert.equal(at(STAT_LAYOUT.dash.firstRow + 1, 1), '', 'null в списке — визуальный разделитель');
  assert.equal(at(STAT_LAYOUT.dist.headerRow, 1), '— Win Distribution —');
  assert.deepEqual(port.read('stats', STAT_LAYOUT.dist.subHeaderRow, 1, 1, 5)[0],
    ['Label', 'Total %', 'Total %RTP', 'FG %sess', 'FG %RTP']);
  assert.deepEqual(port.read('stats', STAT_LAYOUT.combo.subHeaderRow, 1, 1, 3)[0],
    ['Symbol × Length', 'BASE', 'FG']);
  assert.equal(at(STAT_LAYOUT.combo.firstRow, 1), 'Ace 3of');

  // сырьё: мета, шапка, инвалидация, лейблы + агрегатные формулы
  assert.deepEqual(port.read('stats', STAT_LAYOUT.metaRow, L.aggCol, 1, SHARDS + 1)[0],
    ['stat', 'stat', 'stat', 'stat']);
  assert.deepEqual(port.read('stats', STAT_LAYOUT.headerRow, L.aggCol, 1, SHARDS + 1)[0],
    ['АГРЕГАТ', 1, 2, 3]);
  assert.equal(at(STAT_LAYOUT.staleRow, L.aggCol), init.hash, 'хэш init лежит в строке инвалидации');
  assert.equal(at(L.firstRow, L.labelCol), (rows[0] as { label: string }).label);
  const roundsRow = statsManifestRow(rows, 'Rounds');
  assert.equal(at(roundsRow, L.aggCol), '=SUM(D' + roundsRow + ':F' + roundsRow + ')');
  assert.ok(String(at(roundsRow + 0, L.aggCol)).indexOf(',') < 0, 'формулы локализованы под диалект ru_RU');
});

test('prepareRun: оформление вкладки кодифицировано (снапшот стилей и ширин)', () => {
  const port = newPort();
  statsPrepareRun(port, ADAPTER, PARAMS);
  const snap = port.snapshot('stats');
  assert.deepEqual(snap.widths, { '1': 260, '2': 320, '3': 120 });
  assert.deepEqual(port.styleAt('stats', STAT_LAYOUT.paramsRow, 1), { bg: '#f1f3f4', bold: true });
  assert.deepEqual(port.styleAt('stats', STAT_LAYOUT.dash.headerRow, 1), { bg: '#d9e2f3', bold: true });
  assert.deepEqual(port.styleAt('stats', STAT_LAYOUT.dist.subHeaderRow, 1), { bold: true });
  assert.deepEqual(port.styleAt('stats', STAT_LAYOUT.headerRow, L.aggCol), { bg: '#e8eaed', bold: true });
  assert.deepEqual(port.styleAt('stats', STAT_LAYOUT.metaRow, L.aggCol), { fontColor: '#999999' });
  // дата provenance — числовой формат диалекта, иначе serial-число останется числом
  const dateRow = statsManifestRow(manifestRows(), 'date');
  assert.deepEqual(port.styleAt('stats', dateRow, L.aggCol), { numberFormat: 'dd.MM.yyyy HH:mm' });
});

test('оформление отключаемо: styles false — только значения', () => {
  const port = newPort();
  statsPrepareRun(port, ADAPTER, PARAMS, { styles: false });
  const snap = port.snapshot('stats');
  assert.deepEqual(snap.widths, {});
  assert.deepEqual(Object.keys(snap.styles).filter((k) => !k.startsWith(String(
    statsManifestRow(manifestRows(), 'date')) + ':')), [], 'из оформления остаётся только формат даты');
});

test('init пересобирает вкладку: колонки прошлой комбинации не остаются', () => {
  const port = newPort();
  runAll(port);
  const before = port.read('stats', L.firstRow, L.firstShardCol, 1, 1)[0]?.[0];
  assert.notEqual(before, '');
  statsPrepareRun(port, ADAPTER, { ...PARAMS, shards: 1 });
  assert.equal(port.read('stats', L.firstRow, L.firstShardCol, 1, 1)[0]?.[0], '',
    'старые числа стёрты — иначе агрегат смешал бы прогоны');
});

// --- шарды и агрегат ---------------------------------------------------------------------------

test('computeShard: чистый счётчик — шит не трогает, сид колонки = seed + shard − 1', () => {
  const port = newPort();
  statsPrepareRun(port, ADAPTER, PARAMS);
  const before = JSON.stringify(port.snapshot('stats').values);
  const s2 = statsComputeShard(ADAPTER, 2, PARAMS);
  assert.equal(JSON.stringify(port.snapshot('stats').values), before, 'шард в шит не писал');
  assert.equal(s2.seed, SEED + 1);
  assert.equal(s2.rounds, ROUNDS);
  assert.equal(s2.profile, 'rtp96');
  assert.ok(s2.rtp > 0 && s2.seconds >= 0);
  const s1 = statsComputeShard(ADAPTER, 1, PARAMS);
  assert.notEqual(rowsByLabel(s1.rows)['E[win]/round (coins)'], rowsByLabel(s2.rows)['E[win]/round (coins)'],
    'колонки — независимые последовательности');
});

test('writeRun: колонки на местах, производное пустое, агрегат формулами == aggregateRows кодом', () => {
  const port = newPort();
  const results = runAll(port);
  const rows = results[0]?.rows ?? [];
  const rowOf = (label: string): number => statsManifestRow(rows, label);

  for (let s = 0; s < SHARDS; s++) {
    const col = L.firstShardCol + s;
    assert.equal(port.read('stats', rowOf('profile'), col, 1, 1)[0]?.[0], 'rtp96');
    assert.equal(port.read('stats', rowOf('seed'), col, 1, 1)[0]?.[0], SEED + s);
    assert.equal(port.read('stats', rowOf('config_hash'), col, 1, 1)[0]?.[0], results[s]?.hash);
    assert.equal(port.read('stats', STAT_LAYOUT.staleRow, col, 1, 1)[0]?.[0], 'ok');
  }
  assert.equal(port.read('stats', rowOf('RTP % total'), L.firstShardCol, 1, 1)[0]?.[0], '',
    'производные строки считает агрегат, а не колонка (§3.1)');

  const code = aggregateRows(results.map((r) => r.rows));
  const sheet = statsAggregateFromSheet(port);
  assert.equal(sheet.length, code.length);
  for (let i = 0; i < code.length; i++) {
    const label = (code[i] as { label: string }).label;
    if (label === 'date' || label === 'Time, s' || label === 'Speed (rps)') continue;
    assert.equal((sheet[i] as { label: string }).label, label);
    const mine = (code[i] as { value: unknown }).value;
    const got = (sheet[i] as { value: unknown }).value;
    if (typeof mine === 'number') {
      assert.ok(Math.abs(Number(got) - mine) <= Math.max(1e-9, Math.abs(mine) * 1e-12),
        `«${label}»: формула ${got} ≠ коду ${mine}`);
    } else {
      assert.equal(String(got), String(mine), `«${label}»`);
    }
  }
  assert.equal(rowsByLabel(code)['Rounds'], ROUNDS * SHARDS, 'агрегат сложил все колонки');
});

test('writeRun в чужую раскладку — громкая ошибка (лейблы вкладки ≠ манифесту)', () => {
  const port = newPort();
  statsPrepareRun(port, ADAPTER, PARAMS);
  const res = statsComputeShard(ADAPTER, 1, PARAMS);
  port.write('stats', L.firstRow, L.labelCol, [['посторонний лейбл']]);
  assert.throws(() => statsWriteRun(port, ADAPTER, [res], PARAMS), /≠ манифесту/);
  assert.throws(() => statsWriteRun(port, ADAPTER, [], PARAMS), /нет ни одной досчитанной колонки/);
});

// --- statSummary и врайтбек --------------------------------------------------------------------

test('commitSummary: снапшот агрегата ЗНАЧЕНИЯМИ по ключу профиль × режим', () => {
  const port = newPort();
  const results = runAll(port);
  const res = statsCommitSummary(port, ADAPTER, PARAMS);
  assert.equal(res.columns, SHARDS);
  assert.equal(res.col, STAT_LAYOUT.summary.firstKeyCol);

  const S = STAT_LAYOUT.summary;
  const grid = portGrid(port, 'statSummary');
  const col = res.col - 1;
  assert.equal((grid[S.metaRow - 1] as Cell[])[col], 'stat');
  assert.equal((grid[S.profileRow - 1] as Cell[])[col], 'rtp96');
  assert.equal((grid[S.modeRow - 1] as Cell[])[col], 'base');

  const code = rowsByLabel(aggregateRows(results.map((r) => r.rows)));
  let rtpRow = -1;
  for (let r = S.firstRow - 1; r < grid.length; r++) {
    if (String((grid[r] as Cell[])[S.labelCol - 1]) === 'RTP % total') { rtpRow = r; break; }
  }
  assert.ok(rtpRow > 0, 'строка RTP % total в statSummary есть');
  const v = (grid[rtpRow] as Cell[])[col];
  assert.equal(typeof v, 'number', 'копия значениями, не формулами');
  assert.ok(Math.abs(Number(v) - Number(code['RTP % total'])) < 1e-9,
    'в statSummary уехал агрегат, а не одна колонка');

  // второй прогон той же комбинации — та же колонка (оверврайт), другой режим — новая
  statsCommitSummary(port, ADAPTER, PARAMS);
  assert.equal(portGrid(port, 'statSummary')[S.profileRow - 1]?.length, res.col);
});

test('writeActuals: адресный врайтбек агрегата, формулы соседей живы', () => {
  const port = newPort();
  const results = runAll(port);
  const r = statsWriteActuals(port, ADAPTER, PARAMS);
  assert.equal(r.written, 4);
  assert.equal(r.columns, SHARDS);
  assert.equal(r.hash, results[0]?.hash);

  const code = rowsByLabel(aggregateRows(results.map((x) => x.rows)));
  const grid = portGrid(port, 'profiles');
  const cell = (name: string): Cell => {
    for (const row of grid) if (String((row as Cell[])[1]).trim() === name) return (row as Cell[])[3];
    throw new Error('нет строки ' + name);
  };
  const round6 = (v: unknown): number => Math.round(Number(v) * 1e6) / 1e6;
  assert.equal(cell('actual_rtp'), round6(code['RTP % total']));
  assert.equal(cell('actual_std'), round6(code['STD (per round, bets)']));
  assert.equal(cell('actual_hash'), results[0]?.hash);
  assert.ok(Number(cell('actual_date')) > 40000, 'дата — serial-число, не строка');
  assert.equal(port.styleAt('profiles', 6, 4).numberFormat, 'dd.MM.yyyy HH:mm');
  // снимок хранилища, а не чтение через порт: порт (как и getValues) отдаёт ВЫЧИСЛЕННОЕ значение
  const stored = port.snapshot('profiles').values;
  assert.equal(String(((stored[7] || []) as Cell[])[3]).indexOf('=IF('), 0,
    'формула соседней ячейки не перезатёрта: врайтбек адресный, гридом не пишем');
});

test('врайтбек: нет строки actual_* — громкая ошибка, не тихий скип (§3.3)', () => {
  const port = new MemPort(
    { stats: [], statSummary: [], profiles: profilesGrid().filter((row) => (row as Cell[])[1] !== 'actual_std') },
    { evaluate: sheetEvaluator }
  );
  runAll(port);
  assert.throws(() => statsWriteActuals(port, ADAPTER, PARAMS), /actual_std/);
});

// --- инвалидация и однородность ----------------------------------------------------------------

test('однородность: колонки от разных прогонов в агрегат не пускаются', () => {
  const port = newPort();
  const results = runAll(port);
  const check = statsAssertHomogeneous(port, ADAPTER, 'rtp96', 'base');
  assert.deepEqual({ columns: check.columns, mode: check.mode, profile: check.profile },
    { columns: SHARDS, mode: 'base', profile: 'rtp96' });

  const modeRow = statsManifestRow(results[0]?.rows ?? [], 'mode');
  port.write('stats', modeRow, L.firstShardCol + 1, [['feature6']]);
  assert.throws(() => statsCommitSummary(port, ADAPTER, PARAMS), /разных прогонов/);
});

test('смена конфига → колонки протухли и кричат об этом (§1, §5.5)', () => {
  const port = newPort();
  runAll(port);
  const before = statsCheckStale(port, ADAPTER, 'rtp96');
  assert.deepEqual({ stale: before.stale, columns: before.columns, ready: before.ready },
    { stale: 0, columns: SHARDS, ready: true });

  // другой профиль = другой тюнинг = другой хэш конфига
  const after = statsCheckStale(port, ADAPTER, 'rtp94');
  assert.notEqual(after.hash, before.hash);
  assert.equal(after.stale, SHARDS, 'все колонки помечены протухшими');
  assert.equal(port.read('stats', STAT_LAYOUT.staleRow, L.firstShardCol, 1, 1)[0]?.[0], 'ПРОТУХЛА');
  assert.throws(() => statsWriteActuals(port, ADAPTER, { ...PARAMS, profile: 'rtp94' }), /лежит прогон|протухл/i);
});

test('config_hash накрывает раскладку манифеста: смена лестницы протухляет колонки', () => {
  const config = buildConfig('rtp96').config;
  const byLadder = (spec: string): StatsAdapter => ({
    ...ADAPTER,
    manifest(st, _config, prov) {
      const m = manifestBuilder({ bet: BET });
      provenanceSection(m, st as BaseStats, prov);
      histSection(m, [['Total', (st as BaseStats).bkTotal]], makeBucketsFromSpec(spec).buckets());
      return m.build();
    }
  });
  const short = byLadder('1,2,5,10');
  const same = byLadder('1,2,5,10');
  const wide = byLadder('1,2,5,10,20..100:10');

  // снапшот конфига у всех трёх один и тот же — различает их только лестница
  assert.deepEqual(short.snapshot?.(config), wide.snapshot?.(config));
  assert.equal(statsConfigHash(short, config), statsConfigHash(same, config));
  assert.notEqual(statsConfigHash(short, config), statsConfigHash(wide, config));
  assert.match(statsConfigHash(wide, config), /^[0-9a-f]{8}$/);
});

test('витрина распределения рисуется бакетами ИГРЫ, а не дефолтом ядра', () => {
  const bk = makeBucketsFromSpec('1,2,5,10,20..60:10,cap', { cap: 100 });
  const adapter = adapterWithBuckets(bk);
  const port = newPort();
  statsPrepareRun(port, adapter, PARAMS);

  const n = bk.buckets().length;
  const labels = port.read('stats', STAT_LAYOUT.dist.firstRow, 1, n, 1).map((r) => String((r as Cell[])[0]));
  assert.deepEqual(labels, bk.buckets().map((b) => b.label));
  assert.ok(labels.indexOf('[30,40)x') >= 0 && labels.indexOf('100x') >= 0 && labels.indexOf('>100x') >= 0);
  assert.equal(labels.indexOf('[20,50)x'), -1, 'дефолтный бакет ядра в витрине не появился');

  // формулы витрины целятся в строки сырья этой же лестницы
  const rows = adapter.manifest(adapter.newStats(), buildConfig('rtp96').config, {});
  const want = statsManifestRow(rows, 'hist Total 100x N');
  assert.ok(want > 0);
  const capRow = STAT_LAYOUT.dist.firstRow + labels.indexOf('100x');
  const stored = port.snapshot('stats').values; // снимок: порт отдаёт ВЫЧИСЛЕННОЕ, а нужна формула
  assert.match(String(((stored[capRow - 1] || []) as Cell[])[1]), new RegExp('C' + want + '\\b'));
});

test('адаптер со своей лестницей, но без buckets() — громкая ошибка на init', () => {
  const bk = makeBucketsFromSpec('1,2,5,10,20..60:10,cap', { cap: 100 });
  const { buckets: _drop, ...silent } = adapterWithBuckets(bk);
  assert.throws(() => statsPrepareRun(newPort(), silent as StatsAdapter, PARAMS),
    /в манифесте нет строки/, 'витрина не смеет тихо нарисоваться чужой сеткой');
});

test('пустая вкладка: checkStale не готова, агрегат — громкая ошибка, clear идемпотентен', () => {
  const port = newPort();
  assert.deepEqual(statsCheckStale(port, ADAPTER, 'rtp96'), { hash: '', stale: 0, columns: 0, ready: false });
  assert.throws(() => statsAggregateFromSheet(port), /вкладка пуста/);
  assert.deepEqual(statsClearTab(port), { cleared: 0 });
  runAll(port);
  assert.ok(statsClearTab(port).cleared > L.firstRow);
  assert.deepEqual(port.size('stats'), { rows: 0, cols: 0 });
});

test('flush — единственная граница батча: записи не сыпятся по одной', () => {
  const port = newPort();
  statsPrepareRun(port, ADAPTER, PARAMS);
  assert.equal(port.flushes, 1, 'весь init — один батч');
  statsWriteRun(port, ADAPTER, [statsComputeShard(ADAPTER, 1, PARAMS)], PARAMS);
  assert.equal(port.flushes, 2, 'запись всех колонок — один батч');
});
