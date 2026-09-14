// Движок правил агрегации: лейблы-якоря + aggregateRows (агрегация КОДОМ).
//
// Извлечено из sample-slot/src/stats.js без изменений семантики. Двойник — формулы
// агрегатной колонки (grid.ts); §3.1 требует, чтобы оба давали одно число, паритет держится
// тестом (test/aggregate.test.ts исполняет сами формулы).
//
// Правила:
//   section  — разделитель (ни значения, ни формулы)
//   text/date— provenance: первое непустое значение колонок
//   sum/max  — аддитивное / максимум
//   wavg     — среднее, ВЗВЕШЕННОЕ по Rounds (не AVERAGE: у колонок разные N)
//   std      — пул: √((ΣN·σ² + ΣN·μ²)/ΣN − μ_агг²), μ = строка `of`
//   speed    — Rounds / Time
//   noise    — 2×STD×100/√N (шум-порог)
//   rtp      — строка `of` / E[wager]/round × 100
//   share    — строка `of` / Rounds × 100
//   pct      — `of` / `per` × 100
//   ratio    — `of` / `per`
//   one_in   — (`per` или Rounds) / `of` — частота «1 к N»

import type { Agg, Row, RowValue } from './types.ts';

// --- Лейблы-якоря: на них ссылаются правила агрегации, витрина и врайтбек -------------------
export const L_ROUNDS = 'Rounds';
export const L_SPINS = 'Spins (base+FG)';
export const L_WAGERED = 'Wagered (coins)';
export const L_TIME = 'Time, s';
export const L_SPEED = 'Speed (rps)';
export const L_NOISE = 'noise floor % (2×SEM)';
export const L_EWAGER = 'E[wager]/round (coins)';
export const L_EWIN = 'E[win]/round (coins)';
export const L_MEANX = 'Mean win (x bet)';
export const L_STD = 'STD (per round, bets)';
export const L_RTP = 'RTP % total';
export const L_WIN_COUNT = 'Win count';
export const L_HIT = 'Hit rate %';
export const L_MAXWIN_COINS = 'Max win (coins)';
export const L_MAXWIN_X = 'Max win (x bet)';
export const L_WINCAP_HITS = 'Wincap hits';
export const L_WINCAP_ONE_IN = 'Wincap 1/N (per round)';
export const L_WINCAP_ONE_IN_SPIN = 'Wincap 1/N (per spin)';
export const L_WINCAP_PCT = 'Wincap % (per round)';
export const L_DATE = 'date';
export const L_PROFILE = 'profile';
export const L_MODE = 'mode';
export const L_SEED = 'seed';
export const L_CONFIG_HASH = 'config_hash';

/** Правила, у которых колонка прогона несёт СВОЁ значение (остальное считает агрегат). */
export const STAT_VALUE_AGGS: Record<string, 1> = {
  text: 1, date: 1, sum: 1, max: 1, wavg: 1, std: 1, speed: 1, noise: 1
};

/** Несёт ли строка с этим правилом значение в колонке прогона. */
export function isValueAgg(agg: Agg): boolean { return STAT_VALUE_AGGS[agg] === 1; }

/**
 * Агрегация колонок КОДОМ. columns — массив колонок, каждая = массив строк одного манифеста.
 * Возвращает [{label, agg, of, per, value}]; производное посчитано, пустое = '' (как IF(…;"")).
 */
export function aggregateRows(columns: Row[][]): Row[] {
  if (!columns || !columns.length) throw new Error('aggregateRows: нет ни одной колонки');
  const spec = columns[0] as Row[];
  for (let c = 1; c < columns.length; c++) {
    const col = columns[c] as Row[];
    if (col.length !== spec.length) {
      throw new Error('aggregateRows: колонки собраны на разные манифесты (' +
        col.length + ' строк против ' + spec.length + ')');
    }
  }
  const idx: Record<string, number> = {};
  for (let i = 0; i < spec.length; i++) idx[(spec[i] as Row).label] = i;

  // Значения колонок по строке (число или null — пустое в суммах не участвует).
  function col(i: number): Array<number | null> {
    const out: Array<number | null> = [];
    for (let k = 0; k < columns.length; k++) {
      const v = ((columns[k] as Row[])[i] as Row).value;
      out.push(typeof v === 'number' && isFinite(v) ? v : null);
    }
    return out;
  }
  function rowOf(label: string | null, why: string): number {
    const i = label == null ? undefined : idx[label];
    if (i === undefined) throw new Error('aggregateRows: в манифесте нет строки «' + label + '» (' + why + ')');
    return i;
  }
  const weights = col(rowOf(L_ROUNDS, 'вес агрегации'));
  let sumW = 0;
  for (let w = 0; w < weights.length; w++) sumW += weights[w] || 0;

  const out: RowValue[] = new Array(spec.length);
  const busy: Record<number, boolean> = {};

  function value(i: number): RowValue {
    if (out[i] !== undefined) return out[i] as RowValue;
    if (busy[i]) throw new Error('aggregateRows: циклическая ссылка на строке «' + (spec[i] as Row).label + '»');
    busy[i] = true;
    out[i] = compute(i);
    busy[i] = false;
    return out[i] as RowValue;
  }
  function num(label: string | null, why: string): number {
    const v = value(rowOf(label, why));
    return typeof v === 'number' ? v : 0;
  }
  function compute(i: number): RowValue {
    const row = spec[i] as Row;
    const vals = col(i);
    let k: number;
    switch (row.agg) {
      case 'section': return '';
      case 'text': case 'date':
        for (k = 0; k < columns.length; k++) {
          const t = ((columns[k] as Row[])[i] as Row).value;
          if (t !== '' && t != null) return t;
        }
        return '';
      case 'sum': {
        let s = 0;
        for (k = 0; k < vals.length; k++) s += vals[k] || 0;
        return s;
      }
      case 'max': {
        if (!sumW) return '';
        let mx = 0;
        for (k = 0; k < vals.length; k++) {
          const v = vals[k];
          if (v != null && v > mx) mx = v;
        }
        return mx;
      }
      case 'wavg': {
        if (!sumW) return '';
        let acc = 0;
        for (k = 0; k < vals.length; k++) acc += (weights[k] || 0) * (vals[k] || 0);
        return acc / sumW;
      }
      case 'std': {
        if (!sumW) return '';
        const means = col(rowOf(row.of, 'μ для пула STD'));
        let acc2 = 0;
        for (k = 0; k < vals.length; k++) {
          const sg = vals[k] || 0, mu = means[k] || 0;
          acc2 += (weights[k] || 0) * (sg * sg) + (weights[k] || 0) * (mu * mu);
        }
        const mAgg = num(row.of, 'μ агрегата');
        return Math.sqrt(Math.max(0, acc2 / sumW - mAgg * mAgg));
      }
      case 'speed': {
        const t2 = num(L_TIME, 'Speed');
        return t2 ? num(L_ROUNDS, 'Speed') / t2 : '';
      }
      case 'noise': {
        const n2 = num(L_ROUNDS, 'noise floor');
        return n2 ? 2 * num(L_STD, 'noise floor') * 100 / Math.sqrt(n2) : '';
      }
      case 'rtp': {
        const wg = num(L_EWAGER, 'знаменатель RTP');
        return wg ? num(row.of, row.label) / wg * 100 : '';
      }
      case 'share': {
        const n3 = num(L_ROUNDS, row.label);
        return n3 ? num(row.of, row.label) / n3 * 100 : '';
      }
      case 'pct': {
        const p = num(row.per, row.label);
        return p ? num(row.of, row.label) / p * 100 : '';
      }
      case 'ratio': {
        const p2 = num(row.per, row.label);
        return p2 ? num(row.of, row.label) / p2 : '';
      }
      case 'one_in': {
        const of = num(row.of, row.label);
        return of ? num(row.per || L_ROUNDS, row.label) / of : '';
      }
      default:
        throw new Error('aggregateRows: неизвестное правило агрегации «' + (row as Row).agg +
          '» (строка «' + (row as Row).label + '»)');
    }
  }

  const res: Row[] = [];
  for (let r = 0; r < spec.length; r++) {
    const s = spec[r] as Row;
    res.push({ label: s.label, agg: s.agg, of: s.of, per: s.per, value: value(r) });
  }
  return res;
}

/** Лейбл → значение (удобство для врайтбека и логов). */
export function rowsByLabel(rows: Array<{ label: string; value: RowValue }>): Record<string, RowValue> {
  const m: Record<string, RowValue> = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as { label: string; value: RowValue };
    m[r.label] = r.value;
  }
  return m;
}
