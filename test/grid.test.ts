// Раскладка вкладки: адреса, локализация, витрина и запись statSummary / actual_*.
// Промах по лейблу обязан быть громким — тихо пропущенная ячейка витрины выглядит как ноль.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  L_ROUNDS, STAT_LAYOUT, comboContent, dashboardContent, distributionContent, makeLayout,
  statBuckets, statsAggregateFormulas, statsColName, statsFindLabelRow, statsLocalizeFormula,
  statsPlanProfileActuals, statsRectangular, statsShardValues, statsSkeleton, statsStaleFormulas,
  statsTrimTrailing, statsUpsertSummaryColumn, statsWriteProfileActuals
} from '../src/index.ts';
import type { Grid, Row } from '../src/index.ts';
import { CONFIG, manifest, newStats, runShard } from './_fake-game.ts';

const ROWS = manifest(runShard(500, 4242), { profile: 'rtp96', mode: 'base', seconds: 2 });

test('statsColName: 1-based номер колонки → имя', () => {
  assert.equal(statsColName(1), 'A');
  assert.equal(statsColName(3), 'C');
  assert.equal(statsColName(26), 'Z');
  assert.equal(statsColName(27), 'AA');
  assert.equal(statsColName(52), 'AZ');
  assert.equal(statsColName(53), 'BA');
  assert.equal(statsColName(703), 'AAA');
});

test('локализация: запятая → диалект; авторская форма остаётся с запятой', () => {
  const f = '=IF(SUM(D1:F1)=0,"",MAX(D1:F1))';
  assert.equal(statsLocalizeFormula(f, { formulaArg: ';' }), '=IF(SUM(D1:F1)=0;"";MAX(D1:F1))');
  assert.equal(statsLocalizeFormula(f, { formulaArg: ',' }), f);
  assert.equal(statsLocalizeFormula(f), '=IF(SUM(D1:F1)=0;"";MAX(D1:F1))', 'дефолт диалекта — ru_RU');
});

test('скелет: лейблы, формулы, meta/header/stale по числу шардов', () => {
  const sk = statsSkeleton(ROWS, 3, { formulaArg: ';' }, 'cafebabe');
  assert.equal(sk.labels.length, ROWS.length);
  assert.equal(sk.formulas.length, ROWS.length);
  assert.deepEqual(sk.meta, ['stat', 'stat', 'stat', 'stat']);
  assert.deepEqual(sk.header, ['АГРЕГАТ', 1, 2, 3]);
  assert.equal(sk.stale[0], 'cafebabe');
  assert.equal(sk.stale.length, 4);
  for (let i = 1; i < sk.stale.length; i++) {
    assert.ok((sk.stale[i] as string).includes('ПРОТУХЛА'), 'протухшая колонка обязана кричать');
  }
  // секции — без формул и без значений
  const sect = ROWS.findIndex((r) => r.agg === 'section');
  assert.equal((sk.formulas[sect] as string[])[0], '');
  assert.equal((statsShardValues(ROWS)[sect] as [string | number])[0], '');
});

test('без строки config_hash инвалидацию строить не на чем — громкая ошибка', () => {
  const rows = ROWS.filter((r) => r.label !== 'config_hash');
  assert.throws(() => statsStaleFormulas(rows, 2), /config_hash/);
});

test('агрегатные формулы адресуют диапазон шардов и агрегатную колонку', () => {
  const f = statsAggregateFormulas(ROWS, 4);
  const L = STAT_LAYOUT.stats;
  const roundsRow = L.firstRow + ROWS.findIndex((r) => r.label === L_ROUNDS);
  assert.equal(f[ROWS.findIndex((r) => r.label === L_ROUNDS)], `=SUM(D${roundsRow}:G${roundsRow})`);
  const rtpIdx = ROWS.findIndex((r) => r.label === 'RTP % total');
  assert.ok((f[rtpIdx] as string).startsWith('=IF(C'), 'RTP ссылается на агрегатную колонку');
});

test('раскладка параметризуется: makeLayout сдвигает адреса формул', () => {
  const layout = makeLayout({ stats: { firstRow: 10, firstShardCol: 6 }, staleRow: 9 });
  assert.equal(layout.stats.firstRow, 10);
  assert.equal(layout.stats.aggCol, STAT_LAYOUT.stats.aggCol, 'незатронутые поля — из дефолта');
  const f = statsAggregateFormulas(ROWS, 2, layout);
  const idx = ROWS.findIndex((r) => r.label === L_ROUNDS);
  assert.equal(f[idx], `=SUM(F${10 + idx}:G${10 + idx})`);
  assert.equal(STAT_LAYOUT.stats.firstRow, 203, 'дефолтная раскладка не мутирована');
});

test('витрина: лейблы/разделители/пары, промах по лейблу — громкая ошибка', () => {
  const dash = dashboardContent(ROWS, ['RTP % total', null, ['Триггеры', 'Triggers']]);
  assert.equal(dash.length, 3);
  assert.equal((dash[0] as [string, string])[0], 'RTP % total');
  assert.ok((dash[0] as [string, string])[1].startsWith('=C'));
  assert.deepEqual(dash[1], ['', '']);
  assert.equal((dash[2] as [string, string])[0], 'Триггеры');
  assert.throws(() => dashboardContent(ROWS, ['такой строки нет']), /нет строки/);
});

test('распределение: свой знаменатель у каждого набора', () => {
  const dist = distributionContent(ROWS, [{ name: 'Total' }, { name: 'FG', per: 'Triggers' }]);
  assert.equal(dist.length, statBuckets().length);
  const line = dist[0] as string[];
  assert.equal(line[0], '0x');
  assert.equal(line.length, 5, 'лейбл + по паре на набор');
  const roundsRow = STAT_LAYOUT.stats.firstRow + ROWS.findIndex((r) => r.label === L_ROUNDS);
  const trigRow = STAT_LAYOUT.stats.firstRow + ROWS.findIndex((r) => r.label === 'Triggers');
  assert.ok((line[1] as string).includes(`C${roundsRow}`), 'Total считается от Rounds');
  assert.ok((line[3] as string).includes(`C${trigRow}`), 'FG считается от Triggers');
});

test('combo-витрина: строка на символ × длину, колонка на набор', () => {
  const combo = comboContent(ROWS, CONFIG, ['BASE', 'FG']);
  assert.deepEqual(combo.map((r) => r[0]), ['Ace 3of', 'Ace 4of', 'Ace 5of', 'Bell 3of', 'Bell 4of', 'Bell 5of']);
  assert.equal((combo[0] as string[]).length, 3);
  // символ без выплат в витрину не попадает
  assert.ok(!combo.some((r) => String(r[0]).startsWith('Blank')));
});

// --- statSummary --------------------------------------------------------------------------

function summaryRows(): Array<{ label: string; value: number | string | null }> {
  return [{ label: 'Rounds', value: 100 }, { label: 'RTP % total', value: 96.5 }];
}

test('statSummary: ключ профиль × режим — оверврайт колонки, новый ключ — колонка справа', () => {
  const S = STAT_LAYOUT.summary;
  let grid: Grid = [];
  const first = statsUpsertSummaryColumn(grid, { profile: 'rtp96', mode: 'base' }, summaryRows());
  grid = first.grid;
  assert.equal(first.col, S.firstKeyCol);
  assert.equal((grid[S.profileRow - 1] as unknown[])[first.col - 1], 'rtp96');

  const same = statsUpsertSummaryColumn(grid, { profile: 'rtp96', mode: 'base' },
    [{ label: 'Rounds', value: 999 }]);
  assert.equal(same.col, first.col, 'тот же ключ — та же колонка');
  const rowsIdx = statsFindLabelRow(same.grid, S.labelCol, 'RTP % total');
  assert.equal((same.grid[rowsIdx - 1] as unknown[])[first.col - 1], '',
    'колонка чистится целиком: старые строки не остаются висеть');

  const other = statsUpsertSummaryColumn(same.grid, { profile: 'rtp94', mode: 'feature6' }, summaryRows());
  assert.equal(other.col, first.col + 1, 'новый ключ — новая колонка справа');
});

// --- Врайтбек actual_* ---------------------------------------------------------------------

function profilesGrid(): Grid {
  return [
    ['', '', '', ''],
    ['', 'var_name', 'comment', 'rtp96'],
    ['', 'target_rtp', '', 96],
    ['', 'actual_rtp', '', ''],
    ['', 'actual_std', '', '']
  ];
}

test('врайтбек actual_*: адресный план по имени строки и колонке профиля', () => {
  const plan = statsPlanProfileActuals(profilesGrid(), 'rtp96', { actual_rtp: 96.1, actual_std: 4.2 });
  assert.deepEqual(plan.map((p) => [p.key, p.row, p.col]), [['actual_rtp', 4, 4], ['actual_std', 5, 4]]);
  const grid = statsWriteProfileActuals(profilesGrid(), 'rtp96', { actual_rtp: 96.1 });
  assert.equal((grid[3] as unknown[])[3], 96.1);
});

test('врайтбек: нет колонки профиля или строки actual_* — громкая ошибка, не тихий скип', () => {
  assert.throws(() => statsPlanProfileActuals(profilesGrid(), 'rtp99', { actual_rtp: 1 }),
    /колонка профиля «rtp99» не найдена/);
  assert.throws(() => statsPlanProfileActuals(profilesGrid(), 'rtp96', { actual_hit_rate: 1 }),
    /нет обязательных строк врайтбека: actual_hit_rate/);
  assert.throws(() => statsPlanProfileActuals([['', 'нет шапки']], 'rtp96', { actual_rtp: 1 }),
    /не найдена строка-шапка/);
});

test('канонизация грида: дырки → пусто, хвосты обрезаны / прямоугольник', () => {
  const grid: Grid = [['a', null, ''], ['b'], []];
  assert.deepEqual(statsTrimTrailing(grid), [['a'], ['b'], []]);
  assert.deepEqual(statsRectangular([['a', 'b'], ['c']]), [['a', 'b'], ['c', '']]);
});

test('строка по лейблу ищется по значению, а не по позиции', () => {
  const grid: Grid = [['', 'first'], ['', 'second']];
  assert.equal(statsFindLabelRow(grid, 2, 'second'), 2);
  assert.equal(statsFindLabelRow(grid, 2, 'нет такого'), -1);
});

test('пустой манифест игры всё равно даёт скелет (init до первого прогона)', () => {
  const rows: Row[] = manifest(newStats());
  const sk = statsSkeleton(rows, 1, { formulaArg: ';' }, null);
  assert.equal(sk.stale[0], '');
  assert.equal(sk.labels.length, rows.length);
});
