// Агрегация: код (aggregateRows) обязан давать ТЕ ЖЕ числа, что формулы агрегатной колонки
// (§3.1: «расхождение — баг, а не „ну, формулы же“»). Формулы здесь не пересказаны, а исполнены
// (_sheet-eval.ts). Перенос aggregate-parity кейсов sample-slot на синтетическую игру.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STAT_LAYOUT, aggregateRows, rowsByLabel, statsAggregateFormulas, statsShardValues,
  statsSkeleton, L_EWIN, L_ROUNDS
} from '../src/index.ts';
import type { Row } from '../src/index.ts';
import { sheetEvaluator } from './_sheet-eval.ts';
import { BET, manifest, newStats, runShard } from './_fake-game.ts';

const SEED = 20260731;
const ROUNDS = 3000;
const HASH = 'deadbeef';

// K колонок с РАЗНЫМ числом раундов: именно на них AVERAGE соврал бы.
function shardColumns(sizes: number[]): Row[][] {
  return sizes.map((n, s) => manifest(runShard(n, SEED + s), {
    date: 46000 + s, profile: 'rtp96', mode: 'base', seed: SEED + s, config_hash: HASH, seconds: 1 + s
  }));
}

// Разложить скелет + колонки в грид вкладки и вернуть вычислитель формул.
function buildSheet(columns: Row[][]): { value: (r: number, c: number) => unknown; firstRow: number; aggCol: number } {
  const L = STAT_LAYOUT.stats;
  const sk = statsSkeleton(columns[0] as Row[], columns.length, { formulaArg: ',' }, HASH);
  const data: unknown[][] = [];
  data[STAT_LAYOUT.metaRow - 1] = ['', '', ...sk.meta];
  data[STAT_LAYOUT.headerRow - 1] = ['', 'label', ...sk.header];
  data[STAT_LAYOUT.staleRow - 1] = ['', 'config_hash (init)', ...sk.stale];
  const vals = columns.map((c) => statsShardValues(c));
  for (let i = 0; i < sk.labels.length; i++) {
    data[L.firstRow - 1 + i] = ['', (sk.labels[i] as string[])[0], (sk.formulas[i] as string[])[0],
      ...vals.map((v) => (v[i] as [string | number])[0])];
  }
  return { value: sheetEvaluator(data), firstRow: L.firstRow, aggCol: L.aggCol };
}

test('агрегат формулами == aggregateRows кодом (строка в строку)', () => {
  const columns = shardColumns([ROUNDS, ROUNDS * 2, Math.round(ROUNDS / 2), ROUNDS]);
  const code = aggregateRows(columns);
  const sheet = buildSheet(columns);

  let checkedNumbers = 0;
  for (let i = 0; i < code.length; i++) {
    const cell = sheet.value(sheet.firstRow + i, sheet.aggCol);
    const mine = (code[i] as Row).value;
    const label = (code[i] as Row).label;
    if (typeof mine === 'number') {
      assert.equal(typeof cell, 'number', `строка «${label}»: формула дала не число (${JSON.stringify(cell)})`);
      const tol = Math.max(1e-9, Math.abs(mine) * 1e-12);
      assert.ok(Math.abs((cell as number) - mine) <= tol, `строка «${label}»: формула ${cell} ≠ коду ${mine}`);
      checkedNumbers++;
    } else {
      assert.equal(String(cell), String(mine), `строка «${label}»: формула «${cell}» ≠ коду «${mine}»`);
    }
  }
  assert.ok(checkedNumbers > 300, `проверено слишком мало числовых строк: ${checkedNumbers}`);
});

test('пустой прогон: max/wavg/std дают пусто, а не нули', () => {
  const columns = [manifest(newStats(), { profile: 'rtp96', mode: 'base' })];
  const agg = rowsByLabel(aggregateRows(columns));
  assert.equal(agg[L_ROUNDS], 0);
  assert.equal(agg['Max win (coins)'], '');
  assert.equal(agg[L_EWIN], '');
  assert.equal(agg['STD (per round, bets)'], '');
  assert.equal(agg['RTP % total'], '');
  // и формулы шита говорят то же
  const sheet = buildSheet(columns);
  const rows = columns[0] as Row[];
  const idx = rows.findIndex((r) => r.label === 'Max win (coins)');
  assert.equal(sheet.value(sheet.firstRow + idx, sheet.aggCol), '');
});

test('средние взвешены по Rounds, а не AVERAGE (колонки с разными N)', () => {
  const columns = shardColumns([1000, 9000]);
  const agg = rowsByLabel(aggregateRows(columns));
  const by = columns.map((c) => rowsByLabel(c));
  const a = (by[0] as Record<string, number>)[L_EWIN] as number;
  const b = (by[1] as Record<string, number>)[L_EWIN] as number;
  const wavg = (a * 1000 + b * 9000) / 10000;
  const naive = (a + b) / 2;
  assert.ok(Math.abs((agg[L_EWIN] as number) - wavg) < 1e-9, 'агрегат обязан быть взвешен по N');
  assert.ok(Math.abs(wavg - naive) > 1e-6, 'кейс бессмысленен: взвешенное совпало с наивным');
  assert.ok(Math.abs((agg[L_EWIN] as number) - naive) > 1e-9, 'агрегат не должен совпадать с AVERAGE');
});

test('агрегат K шардов == прямому прогону K×N (аддитивность + пул STD)', () => {
  const SHARDS = 4;
  const columns = shardColumns(new Array(SHARDS).fill(ROUNDS));
  const agg = rowsByLabel(aggregateRows(columns));

  // тот же поток раундов, но одним аккумулятором
  const st = newStats();
  for (let s = 0; s < SHARDS; s++) runShard(ROUNDS, SEED + s, st);
  const direct = rowsByLabel(aggregateRows([manifest(st, {
    date: 1, profile: 'rtp96', mode: 'base', seed: SEED, config_hash: HASH, seconds: 1
  })]));

  for (const label of [L_ROUNDS, 'RTP % total', 'RTP % base', 'RTP % feature', 'Hit rate %',
    'STD (per round, bets)', 'Trigger 1/N', 'Feature spin hit %', 'Max win (coins)', 'Feature max steps']) {
    const a = agg[label], d = direct[label];
    assert.equal(typeof a, typeof d, `тип строки «${label}»`);
    if (typeof a === 'number' && typeof d === 'number') {
      assert.ok(Math.abs(a - d) <= Math.max(1e-9, Math.abs(d) * 1e-10),
        `«${label}»: агрегат шардов ${a} ≠ прямому прогону ${d}`);
    }
  }
});

test('манифест: один состав и порядок строк независимо от данных', () => {
  const empty = manifest(newStats());
  const filled = shardColumns([500])[0] as Row[];
  assert.equal(empty.length, filled.length);
  for (let i = 0; i < empty.length; i++) {
    assert.equal((empty[i] as Row).label, (filled[i] as Row).label, `лейбл #${i}`);
    assert.equal((empty[i] as Row).agg, (filled[i] as Row).agg, `правило агрегации #${i}`);
  }
});

test('локализация формул: авторская запятая → диалект документа', () => {
  const rows = manifest(newStats());
  const authored = statsAggregateFormulas(rows, 3);
  const sk = statsSkeleton(rows, 3, { formulaArg: ';' }, 'deadbeef');
  for (let i = 0; i < rows.length; i++) {
    const f = (sk.formulas[i] as string[])[0] as string;
    assert.ok(!f.includes(','), `формула строки «${(rows[i] as Row).label}» осталась с запятой`);
    assert.equal(f, (authored[i] as string).split(',').join(';'));
  }
});

test('колонки на разных манифестах и неизвестное правило — громкая ошибка', () => {
  const a = manifest(runShard(100, SEED));
  const b = a.slice(0, a.length - 1);
  assert.throws(() => aggregateRows([a, b]), /разные манифесты/);
  assert.throws(() => aggregateRows([]), /нет ни одной колонки/);
  const broken = a.map((r) => ({ ...r }));
  (broken[10] as Row).agg = 'нечто' as Row['agg'];
  assert.throws(() => aggregateRows([broken]), /неизвестное правило/);
  const dangling = a.map((r) => ({ ...r }));
  const rtp = dangling.find((r) => r.agg === 'rtp') as Row;
  rtp.of = 'строки такой нет';
  assert.throws(() => aggregateRows([dangling]), /нет строки/);
});

test('bet участвует в средних: Mean win (x bet) == E[win]/round / bet', () => {
  const columns = shardColumns([2000, 500]);
  const agg = rowsByLabel(aggregateRows(columns));
  const meanX = agg['Mean win (x bet)'] as number;
  const eWin = agg[L_EWIN] as number;
  assert.ok(Math.abs(meanX - eWin / BET) < 1e-9, `${meanX} ≠ ${eWin / BET}`);
});
