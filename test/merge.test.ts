// mergeStats обязан побитово совпасть с рукописным aggregateStats sample-slot — иначе
// миграция игры на авто-слияние тихо сдвинет числа. Эталон (копия sample-slot src/stats.js до миграции)
// живёт здесь: сверяемся с ним, а не с пересказом правил.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStats } from '../src/index.ts';
import type { Stats } from '../src/index.ts';
import { rng } from './_fake-game.ts';

type Nested = Record<string, { n: number; coins: number; wins: number }>;
type Flat = Record<string, number>;

interface sample-slotStats extends Stats {
  [k: string]: unknown;
}

function sample-slotNewStats(): Record<string, unknown> {
  return {
    rounds: 0, spins: 0, wagered: 0,
    sumWin: 0, sumBase: 0, sumFg: 0, sumWincap: 0, sumXSq: 0,
    sumHot: 0, sumHotBase: 0, sumHotFg: 0,
    sumFgDry: 0, sumFgLock: 0,
    winRounds: 0, maxWin: 0, wincapHits: 0,
    trigger6: 0, trigger12: 0, fgSpins: 0, fgWinSpins: 0, gateFires: 0, maxSteps: 0,
    famBase: {}, famFg: {},
    bkTotal: {}, bkBase: {}, bkFg: {},
    fineTotal: {}, fineFg: {},
    comboBase: {}, comboFg: {},
    dry6: {}, dry12: {}
  };
}

// --- Эталон: aggregateStats из sample-slot (дословно; типизация намеренно свободная) ----------------
/* eslint-disable @typescript-eslint/no-explicit-any */
function sample-slotAggregateStats(list: any[]): Record<string, unknown> {
  const out: any = sample-slotNewStats();
  function addNested(dst: any, src: any): void {
    for (const k in src) {
      if (!dst[k]) dst[k] = { n: 0, coins: 0, wins: 0 };
      dst[k].n += src[k].n || 0; dst[k].coins += src[k].coins || 0; dst[k].wins += src[k].wins || 0;
    }
  }
  function addFlat(dst: any, src: any): void { for (const k in src) dst[k] = (dst[k] || 0) + src[k]; }
  for (let i = 0; i < list.length; i++) {
    const s: any = list[i];
    out.rounds += s.rounds; out.spins += s.spins; out.wagered += s.wagered;
    out.sumWin += s.sumWin; out.sumBase += s.sumBase; out.sumFg += s.sumFg;
    out.sumWincap += s.sumWincap; out.sumXSq += s.sumXSq;
    out.sumHot += s.sumHot; out.sumHotBase += s.sumHotBase; out.sumHotFg += s.sumHotFg;
    out.sumFgDry += s.sumFgDry; out.sumFgLock += s.sumFgLock;
    out.winRounds += s.winRounds; out.wincapHits += s.wincapHits;
    if (s.maxWin > out.maxWin) out.maxWin = s.maxWin;
    if (s.maxSteps > out.maxSteps) out.maxSteps = s.maxSteps;
    out.trigger6 += s.trigger6; out.trigger12 += s.trigger12;
    out.fgSpins += s.fgSpins; out.fgWinSpins += s.fgWinSpins; out.gateFires += s.gateFires;
    addFlat(out.famBase, s.famBase); addFlat(out.famFg, s.famFg);
    addFlat(out.comboBase, s.comboBase); addFlat(out.comboFg, s.comboFg);
    addNested(out.bkTotal, s.bkTotal); addNested(out.bkBase, s.bkBase); addNested(out.bkFg, s.bkFg);
    addNested(out.fineTotal, s.fineTotal); addNested(out.fineFg, s.fineFg);
    addNested(out.dry6, s.dry6); addNested(out.dry12, s.dry12);
  }
  return out;
}

const OVERRIDES = { maxWin: 'max', maxSteps: 'max' } as const;

// Шард с реалистичным содержимым: дробные суммы (sumXSq — float), разреженные карты
// (у каждого шарда свой набор ключей), нулевые и ненулевые счётчики.
function makeShard(seed: number, size: number): Record<string, unknown> {
  const r = rng(seed);
  const st = sample-slotNewStats() as Record<string, unknown>;
  const num = (): number => Math.round(r() * size * 1000) / 7; // не целое: ловит порядок сложения
  for (const k of ['rounds', 'spins', 'wagered', 'sumWin', 'sumBase', 'sumFg', 'sumWincap',
    'sumXSq', 'sumHot', 'sumHotBase', 'sumHotFg', 'sumFgDry', 'sumFgLock', 'winRounds',
    'wincapHits', 'trigger6', 'trigger12', 'fgSpins', 'fgWinSpins', 'gateFires']) {
    st[k] = num();
  }
  st.maxWin = Math.floor(r() * 100000);
  st.maxSteps = Math.floor(r() * 12);
  for (const key of ['famBase', 'famFg', 'comboBase', 'comboFg']) {
    const m: Flat = {};
    const count = 3 + Math.floor(r() * 6);
    for (let i = 0; i < count; i++) m['k' + Math.floor(r() * 12)] = num();
    st[key] = m;
  }
  for (const key of ['bkTotal', 'bkBase', 'bkFg', 'fineTotal', 'fineFg', 'dry6', 'dry12']) {
    const m: Nested = {};
    const count = 3 + Math.floor(r() * 8);
    for (let i = 0; i < count; i++) {
      m['b' + Math.floor(r() * 15)] = { n: Math.floor(r() * 900), coins: num(), wins: Math.floor(r() * 400) };
    }
    st[key] = m;
  }
  return st;
}

function assertSameStats(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
  for (const k of Object.keys(expected)) {
    const e = expected[k], a = actual[k];
    if (typeof e === 'number') {
      assert.ok(Object.is(a, e), `поле «${k}»: ${a} ≠ ${e} (побитово)`);
    } else {
      const em = e as Record<string, unknown>, am = (a || {}) as Record<string, unknown>;
      for (const kk of Object.keys(em)) {
        const ev = em[kk], av = am[kk];
        if (typeof ev === 'number') {
          assert.ok(Object.is(av, ev), `«${k}.${kk}»: ${av} ≠ ${ev}`);
        } else {
          const evo = ev as Record<string, number>, avo = (av || {}) as Record<string, number>;
          for (const f of Object.keys(evo)) {
            assert.ok(Object.is(avo[f], evo[f]), `«${k}.${kk}.${f}»: ${avo[f]} ≠ ${evo[f]}`);
          }
        }
      }
      // и наоборот: лишних ключей ядро не рожает
      assert.deepEqual(Object.keys(am).sort(), Object.keys(em).sort(), `набор ключей «${k}»`);
    }
  }
}

test('mergeStats == aggregateStats sample-slot побитово (8 шардов разного размера)', () => {
  const shards = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => makeShard(1000 + i, i * 137));
  const expected = sample-slotAggregateStats(shards);
  const actual = mergeStats(shards as unknown as sample-slotStats[], OVERRIDES as never) as unknown as Record<string, unknown>;
  assertSameStats(actual, expected);
});

test('mergeStats: один шард == самому шарду, пустой список == пусто', () => {
  const one = makeShard(77, 300);
  const actual = mergeStats([one] as unknown as sample-slotStats[], OVERRIDES as never) as unknown as Record<string, unknown>;
  assertSameStats(actual, sample-slotAggregateStats([one]));
  assert.deepEqual(mergeStats([]), {});
});

test('mergeStats: без override поле складывается, с override max — берёт максимум', () => {
  const a = { rounds: 3, maxWin: 10, maxSteps: 6 } as unknown as Stats;
  const b = { rounds: 4, maxWin: 7, maxSteps: 12 } as unknown as Stats;
  const summed = mergeStats([a, b]) as unknown as Record<string, number>;
  assert.equal(summed.maxWin, 17, 'без override максимум сложился бы — это и проверяем');
  const ruled = mergeStats([a, b], { maxWin: 'max', maxSteps: 'max' }) as unknown as Record<string, number>;
  assert.equal(ruled.rounds, 7);
  assert.equal(ruled.maxWin, 10);
  assert.equal(ruled.maxSteps, 12);
});

test('mergeStats: новые ключи карт создаются, provenance-строки берут первую непустую', () => {
  const a = { m: { x: 1 }, hash: '', profile: 'rtp96' } as unknown as Stats;
  const b = { m: { x: 2, y: 5 }, hash: 'abc', profile: 'rtp97' } as unknown as Stats;
  const out = mergeStats([a, b]) as unknown as { m: Record<string, number>; hash: string; profile: string };
  assert.deepEqual(out.m, { x: 3, y: 5 });
  assert.equal(out.hash, 'abc');
  assert.equal(out.profile, 'rtp96');
});

test('mergeStats: вложенность любой глубины, исходники не мутируются', () => {
  const a = { deep: { one: { two: { n: 1 } } } } as unknown as Stats;
  const b = { deep: { one: { two: { n: 2, coins: 4 } } } } as unknown as Stats;
  const out = mergeStats([a, b]) as unknown as { deep: { one: { two: { n: number; coins: number } } } };
  assert.deepEqual(out.deep.one.two, { n: 3, coins: 4 });
  assert.deepEqual((a as unknown as { deep: { one: { two: unknown } } }).deep.one.two, { n: 1 });
});
