// Синтетический слот для тестов ядра: минимальная игра, покрывающая ВСЕ правила агрегации
// (section/text/date/sum/max/wavg/std/speed/noise/rtp/share/pct/ratio/one_in) и все секции
// манифеста. Ядро не должно тянуть за собой настоящий движок, чтобы его проверить.

import {
  DEFAULT_BUCKETS, L_ROUNDS, accumulateBase, addCoins, baseStats, bumpN, bumpWin, comboSection,
  fineSection, histSection, manifestBuilder, provenanceSection, rtpSection
} from '../src/index.ts';
import type { Buckets, Cell, CoinMap, CountMap, Provenance, Row, Stats, StatsAdapter } from '../src/index.ts';

export const BET = 15;

export const CONFIG = {
  symbols: [{ id: 'A', name: 'Ace' }, { id: 'B', name: 'Bell' }, { id: 'Z', name: 'Blank' }],
  paytable: {
    A: { 3: 5, 4: 20, 5: 100 },
    B: { 3: 2, 4: 10, 5: 50 }
  } as Record<string, Record<string, number> | undefined>
};

export const WINCAP = 5000;

export interface FakeStats extends Stats {
  sumBase: number; sumFeature: number; sumWincap: number; sumHot: number;
  wincapHits: number; triggers: number; featureSpins: number; featureWinSpins: number;
  maxSteps: number;
  bkBase: CountMap; bkFeature: CountMap; fineFeature: CountMap;
  comboBase: CoinMap; comboFeature: CoinMap; dry: CountMap;
}

export function newStats(): FakeStats {
  return {
    ...baseStats(),
    sumBase: 0, sumFeature: 0, sumWincap: 0, sumHot: 0,
    wincapHits: 0, triggers: 0, featureSpins: 0, featureWinSpins: 0, maxSteps: 0,
    bkBase: {}, bkFeature: {}, fineFeature: {},
    comboBase: {}, comboFeature: {}, dry: {}
  };
}

/** mulberry32 — детерминированный PRNG теста (движка у ядра нет). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYMS = ['A', 'B'];

// Лейблы бакетов берём из ядра — тест не пересказывает словарь.
const bucketOf = (x: number): string => DEFAULT_BUCKETS.bucketLabel(x);
const fineOf = (x: number): string => DEFAULT_BUCKETS.fineLabel(x);

function lineWins(r: () => number, map: CoinMap): { coins: number; hot: number } {
  let coins = 0, hot = 0;
  const lines = Math.floor(r() * 3);
  for (let i = 0; i < lines; i++) {
    const sym = SYMS[Math.floor(r() * SYMS.length)] as string;
    const len = 3 + Math.floor(r() * 3);
    const pay = (CONFIG.paytable[sym] as Record<string, number>)[len] as number;
    const boost = r() < 0.2 ? pay : 0; // «hot»: доплата сверх базовой выплаты
    addCoins(map, sym + '|' + len, pay + boost);
    coins += pay + boost;
    hot += boost;
  }
  return { coins, hot };
}

/** Один раунд синтетической игры: базовый спин + иногда фича из 6/12 спинов. */
export function playRound(st: FakeStats, r: () => number): void {
  const base = r() < 0.35 ? lineWins(r, st.comboBase) : { coins: 0, hot: 0 };
  let feature = 0;
  const triggered = r() < 0.05;
  if (triggered) {
    st.triggers++;
    const steps = r() < 0.5 ? 6 : 12;
    if (steps > st.maxSteps) st.maxSteps = steps;
    for (let s = 1; s <= steps; s++) {
      st.featureSpins++;
      st.spins++;
      const spin = r() < 0.45 ? lineWins(r, st.comboFeature) : { coins: 0, hot: 0 };
      if (spin.coins > 0) st.featureWinSpins++;
      st.sumHot += spin.hot;
      feature += spin.coins;
      bumpWin(st.dry, 'spin ' + s, spin.coins);
    }
  }
  let total = base.coins + feature;
  const capped = total > WINCAP;
  if (capped) total = WINCAP;

  accumulateBase(st, total, BET);
  st.sumHot += base.hot;
  st.sumFeature += feature;
  if (capped) { st.wincapHits++; st.sumWincap += total - feature; }
  else st.sumBase += base.coins;

  bumpN(st.bkBase, bucketOf(base.coins / BET), base.coins);
  if (triggered) {
    bumpN(st.bkFeature, bucketOf(feature / BET), feature);
    bumpN(st.fineFeature, fineOf(feature / BET), feature);
  }
}

/** Прогон шарда: N раундов от сида. */
export function runShard(rounds: number, seed: number, st: FakeStats = newStats()): FakeStats {
  const r = rng(seed);
  for (let i = 0; i < rounds; i++) playRound(st, r);
  return st;
}

/** Манифест синтетической игры: секции ядра + собственные строки яруса C. */
export function manifest(st: FakeStats, prov: Provenance = {}, bk: Buckets = DEFAULT_BUCKETS): Row[] {
  const m = manifestBuilder({ bet: BET });
  provenanceSection(m, st, prov);
  rtpSection(m, st, [
    [{ name: 'base', sum: st.sumBase }, { name: 'feature', sum: st.sumFeature },
      { name: 'wincap', sum: st.sumWincap }],
    [{ name: 'hot', sum: st.sumHot, label: 'E[hot]/round (coins)', rtpLabel: 'RTP % hot (total)' }]
  ], { wincap: { hits: st.wincapHits } });

  m.section('— C: фича —');
  m.row('Triggers', 'sum', st.triggers);
  m.row('Trigger 1/N', 'one_in', null, 'Triggers', L_ROUNDS);
  m.row('Trigger %', 'share', null, 'Triggers');
  m.row('Feature spins', 'sum', st.featureSpins);
  m.row('Feature win spins', 'sum', st.featureWinSpins);
  m.row('Feature spin hit %', 'pct', null, 'Feature win spins', 'Feature spins');
  m.row('Feature avg length', 'ratio', null, 'Feature spins', 'Triggers');
  m.row('Feature max steps', 'max', st.maxSteps);
  for (let s = 1; s <= 12; s++) {
    const e = st.dry['spin ' + s] || {};
    m.row('dry #' + s + ' spins', 'sum', e.n || 0);
    m.row('dry #' + s + ' wins', 'sum', e.wins || 0);
    m.row('dry #' + s + ' hit %', 'pct', null, 'dry #' + s + ' wins', 'dry #' + s + ' spins');
  }

  histSection(m, [['Total', st.bkTotal], ['BASE', st.bkBase], ['FG', st.bkFeature]], bk.buckets());
  fineSection(m, [['Total', st.fineTotal], ['FG', st.fineFeature]], bk.fineLabels());
  comboSection(m, CONFIG, [['BASE', st.comboBase], ['FG', st.comboFeature]]);
  return m.build();
}

/** Правила слияния шардов синтетической игры. */
export const MERGE_OVERRIDES = { maxWin: 'max', maxSteps: 'max' } as const;

// --- Адаптер для table-слоя ------------------------------------------------------------------
// Ровно тот контракт, который table.ts просит у игры: конфиг по профилю, раунд, аккумуляция,
// манифест, витрина, снапшот для хэша, врайтбек.

export const PROFILES = ['rtp96', 'rtp94'];

/** Конфиг «документа»: платящие символы + диалект (ru_RU — формулы через `;`). */
export function buildConfig(profileName?: string | null): {
  config: Record<string, unknown>; profileName: string; profiles: string[];
} {
  const name = profileName || (PROFILES[0] as string);
  if (PROFILES.indexOf(name) < 0) throw new Error('нет профиля «' + name + '»');
  return {
    config: {
      symbols: CONFIG.symbols, paytable: CONFIG.paytable, bet: BET, profile: name,
      // тюнинг профиля входит в хэш: правка после прогона обязана пометить колонки протухшими
      tuning: name === 'rtp96' ? 96 : 94,
      dialect: { formulaArg: ';', date: 'dd.MM.yyyy HH:mm' }
    },
    profileName: name,
    profiles: PROFILES
  };
}

export const ADAPTER: StatsAdapter = {
  buildConfig,
  newStats,
  // Движок теста детерминирован сидом раунда: playRound отдаёт «результат», accumulate его копит —
  // та же развязка, что у настоящей игры (шард ничего не знает про шит).
  playRound(_config, opts) { return { seed: Number(opts['seed']) }; },
  accumulate(st, round, _config) { playRound(st as FakeStats, rng((round as { seed: number }).seed)); },
  manifest(st, _config, prov) { return manifest(st as FakeStats, prov); },
  snapshot(config) { return { paytable: CONFIG.paytable, tuning: config['tuning'] }; },
  dashboard: [['RTP %', 'RTP % total'], null, ['Триггеры', 'Triggers'], ['STD', 'STD (per round, bets)']],
  distSets: [{ name: 'Total' }, { name: 'FG', per: 'Triggers' }],
  distHeader: ['Label', 'Total %', 'Total %RTP', 'FG %sess', 'FG %RTP'],
  comboSets: ['BASE', 'FG'],
  comboConfig() { return CONFIG; },
  actuals(by, ctx) {
    const num = (label: string): Cell => {
      const v = by[label];
      return typeof v === 'number' && isFinite(v) ? Math.round(v * 1e6) / 1e6 : '';
    };
    return {
      actual_rtp: num('RTP % total'),
      actual_std: num('STD (per round, bets)'),
      actual_date: ctx.date,
      actual_hash: ctx.hash
    };
  },
  defaults: { rounds: 500, shards: 2, seed: 4242, modes: ['base'] }
};

/**
 * Та же игра, но со своей лестницей: и манифест, и витрина обязаны идти от НЕЁ. Ровно этим
 * отличается игра с настроенной сеткой распределения от дефолтной (sample-slot после NOT-310).
 */
export function adapterWithBuckets(bk: Buckets): StatsAdapter {
  return {
    ...ADAPTER,
    manifest(st, _config, prov) { return manifest(st as FakeStats, prov, bk); },
    buckets() { return bk.buckets(); }
  };
}
