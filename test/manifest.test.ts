// Манифест sample-slot, собранный из секций ядра, обязан лейбл-в-лейбл (и правило-в-правило,
// и ссылка-в-ссылку) совпасть со старым statRows sample-slot — иначе миграция игры сломает вкладку,
// врайтбек и все сохранённые колонки statSummary.
//
// Эталон: test/fixtures/sample-slot-manifest.tsv — снят с sample-slot 0.1.0 ДО миграции (925 строк).
// Игровая часть (ярусы C и B-семейства) живёт здесь же — это и есть будущий adapter игры,
// проверенный на эталоне до того, как игра его получит.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  L_ROUNDS, L_SPINS, comboSection, fineSection, histSection, manifestBuilder, provenanceSection,
  rtpSection
} from '../src/index.ts';
import type { Provenance, Row, Stats } from '../src/index.ts';

interface sample-slotConfig {
  paylines: number;
  symbols: Array<{ id: number; name: string }>;
  paytable: Record<string, Record<string, number> | undefined>;
  baseFamilies: string[];
  wincapFamily: string;
  fgFamiliesWeighted: string[];
  fgGateFamily: string;
  baseWeights: number[];
  fgWeights: number[];
  trigger: { games6: number; games12: number };
}

const CONFIG = JSON.parse(
  readFileSync(new URL('./fixtures/sample-slot-config.json', import.meta.url), 'utf8')
) as sample-slotConfig;

// Пустой аккумулятор sample-slot (значения манифесту безразличны — сверяются лейблы и правила).
function sample-slotStats(): Stats {
  const zero = {
    rounds: 0, spins: 0, wagered: 0, sumWin: 0, sumXSq: 0, winRounds: 0, maxWin: 0,
    bkTotal: {}, fineTotal: {},
    sumBase: 0, sumFg: 0, sumWincap: 0, sumHot: 0, sumHotBase: 0, sumHotFg: 0,
    sumFgDry: 0, sumFgLock: 0, wincapHits: 0,
    trigger6: 0, trigger12: 0, fgSpins: 0, fgWinSpins: 0, gateFires: 0, maxSteps: 0,
    famBase: {} as Record<string, number>, famFg: {} as Record<string, number>,
    bkBase: {}, bkFg: {}, fineFg: {},
    comboBase: {} as Record<string, number>, comboFg: {} as Record<string, number>,
    dry6: {}, dry12: {}
  };
  return zero as unknown as Stats;
}

// Настроенные доли семейств (санити: движок обязан крутить то, что настроено).
function weightShare(weights: number[] | undefined, idx: number): number {
  if (!weights) return 0;
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += weights[i] || 0;
  return sum ? (weights[idx] || 0) / sum * 100 : 0;
}

const n = (st: Stats, key: string): number => (st[key] as number) || 0;
const map = (st: Stats, key: string): Record<string, number> => (st[key] as Record<string, number>) || {};

/** Манифест sample-slot на секциях ядра: ярусы A/C/B. Будущий src/game-stats.js игры. */
function sample-slotManifest(st: Stats, config: sample-slotConfig, prov: Provenance = {}): Row[] {
  const bet = config.paylines;
  const m = manifestBuilder({ bet });

  provenanceSection(m, st, prov);
  rtpSection(m, st, [
    [{ name: 'base', sum: n(st, 'sumBase') },
      { name: 'FG', sum: n(st, 'sumFg') },
      { name: 'wincap', sum: n(st, 'sumWincap') }],
    [{ name: 'hot (total)', sum: n(st, 'sumHot'), label: 'E[hot]/round (coins)' },
      { name: 'hot (base)', sum: n(st, 'sumHotBase'), label: 'E[hot base]/round (coins)' },
      { name: 'hot (FG)', sum: n(st, 'sumHotFg'), label: 'E[hot FG]/round (coins)' }]
  ], { wincap: { hits: n(st, 'wincapHits') } });

  // --- Ярус C: триггеры и фича ---
  m.section('— C: триггеры и фича —');
  m.row('FG triggers', 'sum', n(st, 'trigger6') + n(st, 'trigger12'));
  m.row('FG trigger 6', 'sum', n(st, 'trigger6'));
  m.row('FG trigger 12', 'sum', n(st, 'trigger12'));
  m.row('FG trigger 1/N', 'one_in', null, 'FG triggers', L_ROUNDS);
  m.row('FG trigger %', 'share', null, 'FG triggers');
  m.row('FG trigger 6 1/N', 'one_in', null, 'FG trigger 6', L_ROUNDS);
  m.row('FG trigger 6 %', 'share', null, 'FG trigger 6');
  m.row('FG trigger 12 1/N', 'one_in', null, 'FG trigger 12', L_ROUNDS);
  m.row('FG trigger 12 %', 'share', null, 'FG trigger 12');
  m.row('FG spins', 'sum', n(st, 'fgSpins'));
  m.row('FG win spins', 'sum', n(st, 'fgWinSpins'));
  m.row('FG spin hit rate %', 'pct', null, 'FG win spins', 'FG spins');
  m.row('FG avg length (spins/trigger)', 'ratio', null, 'FG spins', 'FG triggers');
  m.row('FG max steps', 'max', n(st, 'maxSteps'));
  m.row('FG win (coins)', 'sum', n(st, 'sumFg'));
  m.row('FG win (x bet)', 'sum', n(st, 'sumFg') / bet);
  m.row('FG avg win (coins/trigger)', 'ratio', null, 'FG win (coins)', 'FG triggers');
  m.row('FG avg win (x bet/trigger)', 'ratio', null, 'FG win (x bet)', 'FG triggers');
  m.row('FG dry coins', 'sum', n(st, 'sumFgDry'));
  m.row('FG lock coins', 'sum', n(st, 'sumFgLock'));
  m.row('E[FG dry]/round (coins)', 'wavg', st.rounds ? n(st, 'sumFgDry') / st.rounds : 0);
  m.row('E[FG lock]/round (coins)', 'wavg', st.rounds ? n(st, 'sumFgLock') / st.rounds : 0);
  m.row('RTP % FG dry', 'rtp', null, 'E[FG dry]/round (coins)');
  m.row('RTP % FG lock', 'rtp', null, 'E[FG lock]/round (coins)');
  m.row('Gate fires (fg-gate)', 'sum', n(st, 'gateFires'));
  m.row('Gate fire % (of FG spins)', 'pct', null, 'Gate fires (fg-gate)', 'FG spins');
  m.row('Game Over (wincap) count', 'sum', n(st, 'wincapHits'));
  const drySets: Array<[number, Record<string, { n?: number; wins?: number }>]> = [
    [config.trigger.games6, map(st, 'dry6') as never],
    [config.trigger.games12, map(st, 'dry12') as never]
  ];
  for (let d = 0; d < drySets.length; d++) {
    const [rt, dryMap] = drySets[d] as [number, Record<string, { n?: number; wins?: number }>];
    for (let k = 1; k <= rt; k++) {
      const e = dryMap[k] || {};
      m.row('dry ' + rt + 'g #' + k + ' spins', 'sum', e.n || 0);
      m.row('dry ' + rt + 'g #' + k + ' wins', 'sum', e.wins || 0);
      m.row('dry ' + rt + 'g #' + k + ' hit %', 'pct', null,
        'dry ' + rt + 'g #' + k + ' wins', 'dry ' + rt + 'g #' + k + ' spins');
    }
  }
  m.row('Anticipation % (artificial)', 'share', null, 'base family empty-ant count');

  // --- Ярус B: семейства (факт vs настроенные веса) ---
  m.section('— B: семейства (факт vs веса) —');
  for (let f = 0; f < config.baseFamilies.length; f++) {
    const fam = config.baseFamilies[f] as string;
    m.row('base family ' + fam + ' count', 'sum', map(st, 'famBase')[fam] || 0);
    m.row('base family ' + fam + ' %', 'share', null, 'base family ' + fam + ' count');
    m.row('base family ' + fam + ' weight %', 'wavg', weightShare(config.baseWeights, f));
  }
  m.row('base family ' + config.wincapFamily + ' count', 'sum', map(st, 'famBase')[config.wincapFamily] || 0);
  m.row('base family ' + config.wincapFamily + ' %', 'share', null,
    'base family ' + config.wincapFamily + ' count');
  const fgFams = config.fgFamiliesWeighted.concat([config.fgGateFamily]);
  for (let g = 0; g < fgFams.length; g++) {
    const ff = fgFams[g] as string;
    m.row('fg family ' + ff + ' count', 'sum', map(st, 'famFg')[ff] || 0);
    m.row('fg family ' + ff + ' % (of FG spins)', 'pct', null, 'fg family ' + ff + ' count', 'FG spins');
    // Гейт вне весов (он подменяет выбор), поэтому настроенная доля у него не определена.
    m.row('fg family ' + ff + ' weight %', 'wavg',
      g < config.fgFamiliesWeighted.length ? weightShare(config.fgWeights, g) : 0);
  }

  histSection(m, [['Total', st.bkTotal], ['BASE', st['bkBase'] as never], ['FG', st['bkFg'] as never]]);
  fineSection(m, [['Total', st.fineTotal], ['FG', st['fineFg'] as never]]);
  comboSection(m, config, [['BASE', map(st, 'comboBase')], ['FG', map(st, 'comboFg')]]);
  return m.build();
}

interface FixtureRow { label: string; agg: string; of: string; per: string }

function readFixture(): FixtureRow[] {
  const text = readFileSync(new URL('./fixtures/sample-slot-manifest.tsv', import.meta.url), 'utf8');
  const out: FixtureRow[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [label, agg, of, per] = line.split('\t');
    out.push({ label: label as string, agg: agg as string, of: of || '', per: per || '' });
  }
  return out;
}

test('манифест sample-slot через секции == старому statRows (лейбл, правило, of, per)', () => {
  const expected = readFixture();
  const actual = sample-slotManifest(sample-slotStats(), CONFIG);
  const n = Math.min(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i] as FixtureRow;
    const a = actual[i] as Row;
    assert.equal(a.label, e.label, `строка #${i}: лейбл`);
    assert.equal(a.agg, e.agg, `строка #${i} «${e.label}»: правило`);
    assert.equal(a.of || '', e.of, `строка #${i} «${e.label}»: of`);
    assert.equal(a.per || '', e.per, `строка #${i} «${e.label}»: per`);
  }
  assert.equal(actual.length, expected.length, 'число строк манифеста');
});

test('секции ядра дают ровно те лейблы, на которые ссылается витрина sample-slot', () => {
  const rows = sample-slotManifest(sample-slotStats(), CONFIG);
  const have = new Set(rows.map((r) => r.label));
  for (const label of ['RTP % total', 'RTP % base', 'RTP % FG', 'RTP % wincap', 'Hit rate %',
    'Max win (x bet)', 'Max win (coins)', 'Wincap hits', 'Wincap 1/N (per round)',
    'STD (per round, bets)', L_ROUNDS, L_SPINS, 'Speed (rps)', 'noise floor % (2×SEM)',
    'hist Total 0x N', 'hist FG [1000,1500)x %RTP', 'fine Total 0-50 coins',
    'combo BASE Seven 5of %RTP']) {
    assert.ok(have.has(label), `в манифесте нет строки «${label}»`);
  }
});

test('bet берётся из билдера: Max win (x bet) считается по ставке игры', () => {
  const st = sample-slotStats();
  st.maxWin = 3000;
  const rows = sample-slotManifest(st, CONFIG);
  const row = rows.find((r) => r.label === 'Max win (x bet)') as Row;
  assert.equal(row.value, 3000 / CONFIG.paylines);
});
