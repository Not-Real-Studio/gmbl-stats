// Манифест: DSL билдера + секции-генераторы.
//
// Манифест — ЕДИНСТВЕННЫЙ источник лейблов, состава и порядка строк для обоих фронтендов
// (GAS-панель и node CLI). Пустой аккумулятор даёт тот же состав и порядок — это и есть
// манифест для init вкладки.
//
// Игра собирает свой манифест из секций-генераторов и собственных строк между ними:
//   const m = manifestBuilder({ bet });
//   provenanceSection(m, st, prov);
//   rtpSection(m, st, [[{ name: 'base', sum: st.sumBase }, …]], { wincap: { hits: st.wincapHits } });
//   m.section('— C: триггеры и фича —'); m.row('FG triggers', 'sum', st.trigger6 + st.trigger12);
//   histSection(m, [['Total', st.bkTotal]]); fineSection(m, …); comboSection(m, config, …);
//   return m.build();

import type {
  Agg, BaseStats, CoinMap, ComboConfig, CountMap, PayableSymbol, Provenance, Row, RowValue
} from './types.ts';
import { entry } from './accum.ts';
import { DEFAULT_BUCKETS } from './buckets.ts';
import type { Bucket } from './types.ts';
import {
  L_CONFIG_HASH, L_DATE, L_EWAGER, L_EWIN, L_HIT, L_MAXWIN_COINS, L_MAXWIN_X, L_MEANX, L_MODE,
  L_NOISE, L_PROFILE, L_ROUNDS, L_RTP, L_SEED, L_SPEED, L_SPINS, L_STD, L_TIME, L_WAGERED,
  L_WINCAP_HITS, L_WINCAP_ONE_IN, L_WINCAP_ONE_IN_SPIN, L_WINCAP_PCT, L_WIN_COUNT, isValueAgg
} from './aggregate.ts';

// --- Билдер --------------------------------------------------------------------------------

export interface ManifestBuilder {
  /** Накопленные строки (порядок вызовов = порядок строк). */
  rows: Row[];
  /** Ставка раунда в монетах: нужна средним «x bet» и пулу STD. */
  bet: number;
  row(label: string, agg: Agg, value?: RowValue, of?: string | null, per?: string | null): ManifestBuilder;
  section(title: string): ManifestBuilder;
  build(): Row[];
}

export interface ManifestOptions {
  /** Ставка раунда в монетах (дефолт 1). */
  bet?: number;
}

export function manifestBuilder(opts: ManifestOptions = {}): ManifestBuilder {
  const m: ManifestBuilder = {
    rows: [],
    bet: opts.bet === undefined ? 1 : opts.bet,
    row(label, agg, value, of, per) {
      m.rows.push({
        label, agg, of: of || null, per: per || null,
        value: isValueAgg(agg) ? (value === undefined ? null : value) : null
      });
      return m;
    },
    section(title) { return m.row(title, 'section'); },
    build() { return m.rows; }
  };
  return m;
}

// --- Моменты прогона -----------------------------------------------------------------------

export interface Moments {
  rounds: number;
  /** Средний выигрыш в кратностях ставки. */
  meanX: number;
  /** σ выигрыша раунда в кратностях ставки. */
  std: number;
  /** Среднее на раунд от аддитивной суммы. */
  mean(sum: number): number;
}

export function moments(st: BaseStats, bet: number): Moments {
  const N = st.rounds;
  const meanX = N ? st.sumWin / (N * bet) : 0;
  const varX = N ? st.sumXSq / N - meanX * meanX : 0;
  return {
    rounds: N,
    meanX,
    std: Math.sqrt(Math.max(0, varX)),
    mean(sum: number): number { return N ? sum / N : 0; }
  };
}

// --- Секции --------------------------------------------------------------------------------

/**
 * Provenance (§1: колонка прогона анонимной быть не может) + якоря агрегации:
 * date/profile/mode/seed/config_hash + Rounds/Spins/Wagered/Time/Speed/noise floor.
 */
export function provenanceSection(m: ManifestBuilder, st: BaseStats, prov: Provenance = {}): ManifestBuilder {
  const mo = moments(st, m.bet);
  const secs = prov.seconds || 0;
  m.row(L_DATE, 'date', prov.date == null ? '' : prov.date);
  m.row(L_PROFILE, 'text', prov.profile == null ? '' : prov.profile);
  m.row(L_MODE, 'text', prov.mode == null ? '' : prov.mode);
  m.row(L_SEED, 'text', prov.seed == null ? '' : prov.seed);
  m.row(L_CONFIG_HASH, 'text', prov.config_hash == null ? '' : prov.config_hash);
  m.row(L_ROUNDS, 'sum', st.rounds);
  m.row(L_SPINS, 'sum', st.spins);
  m.row(L_WAGERED, 'sum', st.wagered);
  m.row(L_TIME, 'sum', secs);
  m.row(L_SPEED, 'speed', secs ? st.rounds / secs : 0);
  m.row(L_NOISE, 'noise', mo.rounds ? 2 * mo.std * 100 / Math.sqrt(mo.rounds) : 0);
  return m;
}

/** Источник RTP-разложения: имя ведра + его аддитивная сумма монет. */
export interface RtpSource {
  name: string;
  sum: number;
  /** Лейбл строки E[…] (дефолт `E[win {name}]/round (coins)`). */
  label?: string;
  /** Лейбл строки RTP (дефолт `RTP % {name}`). */
  rtpLabel?: string;
}

export interface RtpOptions {
  /** Заголовок секции; null — без заголовка. */
  title?: string | null;
  /** Блок wincap (Wincap hits / 1-к-N по раундам и спинам / %). */
  wincap?: { hits: number } | null;
}

const RTP_TITLE = '— A: RTP и разложение —';

function eLabel(s: RtpSource): string { return s.label || 'E[win ' + s.name + ']/round (coins)'; }
function rLabel(s: RtpSource): string { return s.rtpLabel || 'RTP % ' + s.name; }

/**
 * Ярус A: RTP, разложение по вёдрам, средние и σ, hit rate, max win, опционально wincap.
 *
 * `sources` — либо плоский список вёдер, либо список ГРУПП: каждая группа даёт сначала блок
 * своих строк E[…]/round, затем блок своих RTP-строк (так вёрстка sample-slot: base/FG/wincap, следом
 * hot total/base/FG). Общие E[wager]/E[win]/RTP % total печатаются в первой группе.
 */
export function rtpSection(
  m: ManifestBuilder,
  st: BaseStats,
  sources: RtpSource[] | RtpSource[][] = [],
  opts: RtpOptions = {}
): ManifestBuilder {
  const groups: RtpSource[][] = sources.length && Array.isArray(sources[0])
    ? (sources as RtpSource[][])
    : [sources as RtpSource[]];
  const mo = moments(st, m.bet);
  const title = opts.title === undefined ? RTP_TITLE : opts.title;
  if (title !== null) m.section(title);

  m.row(L_EWAGER, 'wavg', mo.mean(st.wagered));
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g] as RtpSource[];
    if (g === 0) m.row(L_EWIN, 'wavg', mo.mean(st.sumWin));
    for (let i = 0; i < group.length; i++) {
      const s = group[i] as RtpSource;
      m.row(eLabel(s), 'wavg', mo.mean(s.sum));
    }
    if (g === 0) m.row(L_RTP, 'rtp', null, L_EWIN);
    for (let i = 0; i < group.length; i++) {
      const s = group[i] as RtpSource;
      m.row(rLabel(s), 'rtp', null, eLabel(s));
    }
  }

  m.row(L_MEANX, 'wavg', mo.meanX);
  m.row(L_STD, 'std', mo.std, L_MEANX);
  m.row(L_WIN_COUNT, 'sum', st.winRounds);
  m.row(L_HIT, 'share', null, L_WIN_COUNT);
  m.row(L_MAXWIN_COINS, 'max', st.maxWin);
  m.row(L_MAXWIN_X, 'max', st.maxWin / m.bet);

  // Обе единицы сразу: путаница per spin ↔ per round — типовой баг документов.
  if (opts.wincap) {
    m.row(L_WINCAP_HITS, 'sum', opts.wincap.hits);
    m.row(L_WINCAP_ONE_IN, 'one_in', null, L_WINCAP_HITS, L_ROUNDS);
    m.row(L_WINCAP_ONE_IN_SPIN, 'one_in', null, L_WINCAP_HITS, L_SPINS);
    m.row(L_WINCAP_PCT, 'share', null, L_WINCAP_HITS);
  }
  return m;
}

/** Набор распределения: имя блока + карта счётчиков. */
export type HistSet = [string, CountMap] | { name: string; map: CountMap };
/** Набор combo: имя блока + карта `symbolId|length` → монеты. */
export type ComboSet = [string, CoinMap] | { name: string; map: CoinMap };

function setName(s: HistSet | ComboSet): string { return Array.isArray(s) ? s[0] : s.name; }
function histMap(s: HistSet): CountMap { return Array.isArray(s) ? s[1] : s.map; }
function comboMap(s: ComboSet): CoinMap { return Array.isArray(s) ? s[1] : s.map; }

export interface HistOptions {
  /** Заголовок секции; null — без заголовка. */
  title?: string | null;
  /** Знаменатель строк %RTP (дефолт Wagered (coins)). */
  per?: string;
}

const HIST_TITLE = '— B: гистограмма выигрышей —';
const FINE_TITLE = '— B: fine grid (шаг 50x) —';
const COMBO_TITLE = '— B: combo (символ × эффективная длина) —';
const DOT = '·';

function bucketLabels(buckets: Bucket[] | string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i] as Bucket | string;
    out.push(typeof b === 'string' ? b : b.label);
  }
  return out;
}

// Три блока на набор: N, coins, %RTP. Блоки раздельны (а не строка-на-бакет с тремя полями),
// потому что вкладка читается колонками, а диаграммы строятся по непрерывному диапазону.
function distBlocks(
  m: ManifestBuilder, prefix: string, sets: HistSet[], labels: string[], per: string
): ManifestBuilder {
  for (let s = 0; s < sets.length; s++) {
    const set = sets[s] as HistSet;
    const name = setName(set), map = histMap(set);
    m.section(prefix + ' ' + name + ' ' + DOT + ' N');
    for (let i = 0; i < labels.length; i++) {
      const lb = labels[i] as string;
      m.row(prefix + ' ' + name + ' ' + lb + ' N', 'sum', entry(map, lb).n);
    }
    m.section(prefix + ' ' + name + ' ' + DOT + ' coins');
    for (let i = 0; i < labels.length; i++) {
      const lb = labels[i] as string;
      m.row(prefix + ' ' + name + ' ' + lb + ' coins', 'sum', entry(map, lb).coins);
    }
    m.section(prefix + ' ' + name + ' ' + DOT + ' %RTP');
    for (let i = 0; i < labels.length; i++) {
      const lb = labels[i] as string;
      m.row(prefix + ' ' + name + ' ' + lb + ' %RTP', 'pct', null,
        prefix + ' ' + name + ' ' + lb + ' coins', per);
    }
  }
  return m;
}

/** Ярус B: гистограмма выигрышей по бакетам лестницы — N / coins / %RTP на каждый набор. */
export function histSection(
  m: ManifestBuilder,
  sets: HistSet[],
  buckets: Bucket[] | string[] = DEFAULT_BUCKETS.buckets(),
  opts: HistOptions = {}
): ManifestBuilder {
  const title = opts.title === undefined ? HIST_TITLE : opts.title;
  if (title !== null) m.section(title);
  return distBlocks(m, 'hist', sets, bucketLabels(buckets), opts.per || L_WAGERED);
}

/** Ярус B: fine grid (chart-ready, шаг 50x) — N / coins / %RTP на каждый набор. */
export function fineSection(
  m: ManifestBuilder,
  sets: HistSet[],
  labels: string[] = DEFAULT_BUCKETS.fineLabels(),
  opts: HistOptions = {}
): ManifestBuilder {
  const title = opts.title === undefined ? FINE_TITLE : opts.title;
  if (title !== null) m.section(title);
  return distBlocks(m, 'fine', sets, labels, opts.per || L_WAGERED);
}

/** Платящие символы конфига: id/имя/эффективные длины (длины — из paytable, по возрастанию). */
export function payableSymbols(config: ComboConfig): PayableSymbol[] {
  const out: PayableSymbol[] = [];
  for (let i = 0; i < config.symbols.length; i++) {
    const s = config.symbols[i] as { id: string | number; name: string };
    const pay = config.paytable[s.id];
    if (!pay) continue;
    const lens: number[] = [];
    for (const k in pay) lens.push(Number(k));
    lens.sort(function (a, b) { return a - b; });
    out.push({ id: s.id, name: s.name, lens });
  }
  return out;
}

/** Ярус B: combo breakdown (символ × эффективная длина) — coins и %RTP на каждый набор. */
export function comboSection(
  m: ManifestBuilder,
  config: ComboConfig,
  sets: ComboSet[],
  opts: HistOptions = {}
): ManifestBuilder {
  const title = opts.title === undefined ? COMBO_TITLE : opts.title;
  if (title !== null) m.section(title);
  const per = opts.per || L_WAGERED;
  const syms = payableSymbols(config);
  for (let c = 0; c < sets.length; c++) {
    const set = sets[c] as ComboSet;
    const name = setName(set), map = comboMap(set);
    m.section('combo ' + name + ' ' + DOT + ' coins');
    for (let si = 0; si < syms.length; si++) {
      const sym = syms[si] as PayableSymbol;
      for (let li = 0; li < sym.lens.length; li++) {
        const len = sym.lens[li] as number;
        m.row('combo ' + name + ' ' + sym.name + ' ' + len + 'of coins', 'sum',
          map[sym.id + '|' + len] || 0);
      }
    }
    m.section('combo ' + name + ' ' + DOT + ' %RTP');
    for (let si = 0; si < syms.length; si++) {
      const sym = syms[si] as PayableSymbol;
      for (let li = 0; li < sym.lens.length; li++) {
        const len = sym.lens[li] as number;
        const lab = 'combo ' + name + ' ' + sym.name + ' ' + len + 'of';
        m.row(lab + ' %RTP', 'pct', null, lab + ' coins', per);
      }
    }
  }
  return m;
}
