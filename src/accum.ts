// Аккумуляторы: стандартное ядро счётчиков и хелперы наполнения карт.
//
// Правило разделения труда (stats-basis §3.1): аккумулятор копит ТОЛЬКО аддитивное. Всё
// производное (RTP, проценты, 1/N, пул STD) считает агрегатная колонка — формулами или кодом.

import type { BaseStats, CoinMap, CountEntry, CountMap, Stats } from './types.ts';
import { DEFAULT_BUCKETS, type Buckets } from './buckets.ts';

/** Попадание в бакет: +1 к n, +coins к монетам. Ключ создаётся по требованию. */
export function bumpN(map: CountMap, key: string, coins?: number): void {
  let e = map[key];
  if (!e) { e = { n: 0, coins: 0, wins: 0 }; map[key] = e; }
  e.n = (e.n || 0) + 1;
  e.coins = (e.coins || 0) + (coins || 0);
}

/** Плоское накопление: map[key] += v. */
export function addCoins(map: CoinMap, key: string, v: number): void {
  map[key] = (map[key] || 0) + v;
}

/** Выигрышное попадание: +1 к n и, если монеты положительные, +1 к wins. */
export function bumpWin(map: CountMap, key: string, coins: number): void {
  let e = map[key];
  if (!e) { e = { n: 0, coins: 0, wins: 0 }; map[key] = e; }
  e.n = (e.n || 0) + 1;
  e.coins = (e.coins || 0) + (coins || 0);
  if (coins > 0) e.wins = (e.wins || 0) + 1;
}

/** Пустая ячейка распределения (для чтения отсутствующих ключей). */
export const EMPTY_ENTRY: CountEntry = { n: 0, coins: 0, wins: 0 };

/** Счётчики ячейки (отсутствующий ключ = нули) — удобство манифеста. */
export function entry(map: CountMap | undefined, key: string): CountEntry {
  const e = map ? map[key] : undefined;
  if (!e) return EMPTY_ENTRY;
  return { n: e.n || 0, coins: e.coins || 0, wins: e.wins || 0 };
}

/**
 * Стандартное ядро аккумулятора. Игра расширяет спредом:
 * `{ ...baseStats(), sumFg: 0, comboBase: {} }`.
 */
export function baseStats(): BaseStats {
  return {
    rounds: 0, spins: 0, wagered: 0,
    sumWin: 0, sumXSq: 0,
    winRounds: 0, maxWin: 0,
    bkTotal: {}, fineTotal: {}
  };
}

/**
 * Стандартная часть аккумуляции одного раунда: rounds/spins/wagered/sumWin/sumXSq/winRounds/
 * maxWin + гистограмма и fine grid по total-выигрышу. Игровая accumulate зовёт её ПЕРВОЙ
 * строкой, дальше добавляет свою специфику.
 *
 * `betWin` — выигрыш раунда в монетах, `bet` — ставка раунда в монетах.
 * `spins` растёт на 1 (базовый спин); дополнительные спины фичи докручивает игра.
 */
export function accumulateBase(st: Stats, betWin: number, bet: number, buckets: Buckets = DEFAULT_BUCKETS): void {
  st.rounds++;
  st.wagered += bet;
  st.spins++;
  st.sumWin += betWin;
  const x = betWin / bet;
  st.sumXSq += x * x;
  if (betWin > 0) st.winRounds++;
  if (betWin > st.maxWin) st.maxWin = betWin;
  bumpN(st.bkTotal, buckets.bucketLabel(x), betWin);
  if (betWin > 0) bumpN(st.fineTotal, buckets.fineLabel(x), betWin);
}
