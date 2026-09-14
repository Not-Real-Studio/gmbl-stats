// Бакеты распределения выигрышей (§2B стандарта stats-basis: словарь sample-app, в кратностях
// к общей ставке) + fine grid (шаг 50x) под диаграммы.
//
// Извлечено из sample-slot/src/stats.js без изменений семантики. Единственное отличие —
// лестница считается один раз на набор (sample-slot пересобирал массив бакетов на КАЖДЫЙ спин), лейблы
// побитово те же.
//
// Лестница — данные конфига игры, а не константа кода: заказчик калибрует биг-вин сеткой, и
// сетка у каждого слота своя. Записывается строкой DSL (`1,2,5,10,20..100:10,…,cap`), которую
// парсит parseLadder; наружу и в bucketLabel идёт плоский массив границ — он обходится на
// каждый спин миллионного прогона.

import type { Bucket } from './types.ts';

/** Стандартная лестница (sample-app). Игра может передать свою в makeBuckets. */
export const STAT_LADDER: readonly number[] = [1, 2, 5, 10, 20, 50, 75, 100, 125, 150, 200, 250,
  300, 400, 500, 600, 700, 800, 1000, 1500, 2000];

export const STAT_FINE_STEP = 50;
export const STAT_FINE_MAX = 3000;

/** Набор словарей распределения: бакеты лестницы + fine grid. */
export interface Buckets {
  ladder: readonly number[];
  fineStep: number;
  fineMax: number;
  /** Кратность капа выигрыша (точечный бакет + хвост `>Cx`), либо null. */
  cap: number | null;
  /** [{label, lo, hi}] — lo включительно, hi исключительно; нулевой выигрыш отдельным бакетом. */
  buckets(): Bucket[];
  bucketLabel(mult: number): string;
  fineLabels(): string[];
  fineLabel(mult: number): string;
}

// --- DSL лестницы --------------------------------------------------------------------------

/** Относительный допуск сравнений с float: делимость шага, равенство кратности капу. */
const EPS = 1e-9;

/** a + k·s копит ошибку float, а граница попадает в ЛЕЙБЛ строки манифеста — подчищаем. */
function tidy(v: number): number { return Math.round(v * 1e9) / 1e9; }

function toNum(text: string, tok: string): number {
  const v = Number(text);
  if (text === '' || !isFinite(v)) {
    throw new Error('лестница: «' + tok + '» — не число (токен: N, a..b:s или cap)');
  }
  return v;
}

/**
 * Разбор строки лестницы: токены через запятую, пробелы игнорируются.
 * `N` — граница, `a..b:s` — границы a, a+s, …, b включительно, `cap` — маркер капа (последним).
 * Пустая строка — стандартная лестница sample-app.
 *
 * Всё, что похоже на молчаливую потерю границы (шаг не делит диапазон, дубль на стыке
 * сегментов, невозрастающая пара), — ошибка: человек не заметит, что `20..95:10` дало 90.
 */
export function parseLadder(spec: string): { ladder: number[]; hasCap: boolean } {
  const text = (spec === null || spec === undefined ? '' : String(spec)).replace(/\s+/g, '');
  if (!text) return { ladder: STAT_LADDER.slice(), hasCap: false };

  const tokens = text.split(',');
  const ladder: number[] = [];
  let hasCap = false;

  function push(v: number, tok: string): void {
    if (!(v > 0)) {
      throw new Error('лестница: граница ' + v + ' ≤ 0 (токен «' + tok +
        '») — нулевой выигрыш идёт отдельным бакетом 0x');
    }
    if (ladder.length) {
      const prev = ladder[ladder.length - 1] as number;
      if (v === prev) throw new Error('лестница: дубль границы ' + v + ' (токен «' + tok + '»)');
      if (v < prev) {
        throw new Error('лестница: границы не возрастают: ' + prev + ' → ' + v +
          ' (токен «' + tok + '»)');
      }
    }
    ladder.push(v);
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] as string;
    if (!tok) throw new Error('лестница: пустой токен #' + (i + 1) + ' в «' + spec + '»');
    if (tok.toLowerCase() === 'cap') {
      if (i !== tokens.length - 1) {
        throw new Error('лестница: маркер cap допустим только последним токеном, а он #' +
          (i + 1) + ' из ' + tokens.length);
      }
      hasCap = true;
      continue;
    }
    const dd = tok.indexOf('..');
    if (dd < 0) { push(toNum(tok, tok), tok); continue; }

    const colon = tok.indexOf(':', dd + 2);
    if (colon < 0) throw new Error('лестница: сегмент «' + tok + '» без шага — формат a..b:s');
    const a = toNum(tok.slice(0, dd), tok);
    const b = toNum(tok.slice(dd + 2, colon), tok);
    const s = toNum(tok.slice(colon + 1), tok);
    if (!(s > 0)) throw new Error('лестница: сегмент «' + tok + '»: шаг обязан быть > 0');
    if (!(b > a)) throw new Error('лестница: сегмент «' + tok + '»: конец ' + b + ' ≤ начала ' + a);
    const steps = (b - a) / s;
    const n = Math.round(steps);
    if (Math.abs(steps - n) > EPS) {
      throw new Error('лестница: сегмент «' + tok + '»: шаг ' + s + ' не делит ' + (b - a) +
        ' нацело — граница ' + b + ' не попала бы в лестницу');
    }
    for (let k = 0; k <= n; k++) push(tidy(a + k * s), tok);
  }

  if (!ladder.length) throw new Error('лестница «' + spec + '» не дала ни одной границы');
  return { ladder, hasCap };
}

/** Разбор fine grid: `step/max` (например `50/3000`). Пустая строка — стандартный 50/3000. */
export function parseFine(spec: string): { fineStep: number; fineMax: number } {
  const text = (spec === null || spec === undefined ? '' : String(spec)).replace(/\s+/g, '');
  if (!text) return { fineStep: STAT_FINE_STEP, fineMax: STAT_FINE_MAX };
  const parts = text.split('/');
  if (parts.length !== 2) {
    throw new Error('fine grid: «' + spec + '» — формат step/max, например 50/3000');
  }
  const fineStep = Number(parts[0]);
  const fineMax = Number(parts[1]);
  if (!isFinite(fineStep) || !(fineStep > 0) || parts[0] === '') {
    throw new Error('fine grid: шаг «' + parts[0] + '» — не число > 0');
  }
  if (!isFinite(fineMax) || !(fineMax > 0) || parts[1] === '') {
    throw new Error('fine grid: максимум «' + parts[1] + '» — не число > 0');
  }
  const steps = fineMax / fineStep;
  if (Math.abs(steps - Math.round(steps)) > EPS) {
    throw new Error('fine grid: максимум ' + fineMax + ' не делится на шаг ' + fineStep +
      ' нацело — последний бакет получился бы обрезанным');
  }
  return { fineStep, fineMax };
}

// --- Сборка словарей -----------------------------------------------------------------------

function buildBuckets(ladder: readonly number[], cap: number | null): Bucket[] {
  const first = ladder[0] as number;
  const out: Bucket[] = [
    { label: '0x', lo: 0, hi: 0 },
    { label: '(0,' + first + ')x', lo: 0, hi: first }
  ];
  const tail = cap === null ? Infinity : cap;
  for (let i = 0; i < ladder.length; i++) {
    const lo = ladder[i] as number;
    const hi = i + 1 < ladder.length ? (ladder[i + 1] as number) : tail;
    out.push({ label: '[' + lo + (hi === Infinity ? ',+)x' : ',' + hi + ')x'), lo, hi });
  }
  if (cap !== null) {
    out.push({ label: cap + 'x', lo: cap, hi: cap, exact: true });
    out.push({ label: '>' + cap + 'x', lo: cap, hi: Infinity });
  }
  return out;
}

function buildFineLabels(step: number, max: number): string[] {
  const out: string[] = [];
  for (let v = 0; v < max; v += step) out.push(v + '-' + (v + step));
  out.push(max + '+');
  return out;
}

/**
 * Словари распределения под свою лестницу. Дефолт — стандартный словарь sample-app.
 * Массивы строятся один раз: bucketLabel зовётся на каждый спин прогона в миллион раундов.
 *
 * `cap` — кратность капа выигрыша: хвост становится `[last,C)x`, `Cx`, `>Cx` вместо `[last,+)x`.
 */
export function makeBuckets(
  ladder: readonly number[] = STAT_LADDER,
  fineStep: number = STAT_FINE_STEP,
  fineMax: number = STAT_FINE_MAX,
  cap: number | null = null
): Buckets {
  if (!ladder.length) throw new Error('buckets: лестница пуста — нужна хотя бы одна граница');
  const capV = cap === undefined ? null : cap;
  const last = ladder[ladder.length - 1] as number;
  if (capV !== null) {
    if (!isFinite(capV) || !(capV > 0)) {
      throw new Error('buckets: cap обязан быть числом > 0, получено ' + capV);
    }
    if (!(capV > last + EPS * capV)) {
      throw new Error('buckets: cap ' + capV + ' ≤ последней границы лестницы ' + last +
        ' — бакет [' + last + ',' + capV + ')x пуст');
    }
  }

  const list = buildBuckets(ladder, capV);
  const fine = buildFineLabels(fineStep, fineMax);
  const last_ = list[list.length - 1] as Bucket;
  const fineSteps = fineMax / fineStep;
  // Кратность приходит делением монет на ставку и с капом побитово не совпадает — сравнение
  // на равенство напрямую отправило бы законный кап в `>Cx`.
  const tol = capV === null ? 0 : EPS * capV;
  const capLabel = capV === null ? '' : capV + 'x';
  const overLabel = capV === null ? '' : '>' + capV + 'x';
  return {
    ladder,
    fineStep,
    fineMax,
    cap: capV,
    buckets(): Bucket[] { return list.slice(); },
    bucketLabel(mult: number): string {
      if (!(mult > 0)) return '0x';
      if (capV !== null && mult >= capV - tol) return mult <= capV + tol ? capLabel : overLabel;
      for (let i = 1; i < list.length; i++) {
        const b = list[i] as Bucket;
        if (mult >= b.lo && mult < b.hi) return b.label;
      }
      return last_.label;
    },
    fineLabels(): string[] { return fine.slice(); },
    fineLabel(mult: number): string {
      const i = Math.floor(mult / fineStep);
      return i >= fineSteps ? fineMax + '+' : (i * fineStep) + '-' + ((i + 1) * fineStep);
    }
  };
}

/**
 * Словари по строке лестницы из конфига игры. `cap` в строке обязывает игру передать значение:
 * без него хвост молча стал бы `[last,+)x`, а не разложением капа.
 */
export function makeBucketsFromSpec(
  spec: string,
  opts: { cap?: number | null; fine?: string } = {}
): Buckets {
  const parsed = parseLadder(spec);
  const cap = opts.cap === undefined ? null : opts.cap;
  if (parsed.hasCap && cap === null) {
    throw new Error('buckets: лестница просит cap, а игра его не передала (opts.cap)');
  }
  const fine = parseFine(opts.fine === undefined ? '' : opts.fine);
  return makeBuckets(parsed.ladder, fine.fineStep, fine.fineMax, parsed.hasCap ? cap : null);
}

/** Стандартный набор (лестница sample-app, fine 50/3000) — на нём работают дефолты ядра. */
export const DEFAULT_BUCKETS: Buckets = makeBuckets();

export function statBuckets(): Bucket[] { return DEFAULT_BUCKETS.buckets(); }
export function statBucketLabel(mult: number): string { return DEFAULT_BUCKETS.bucketLabel(mult); }
export function statFineLabels(): string[] { return DEFAULT_BUCKETS.fineLabels(); }
export function statFineLabel(mult: number): string { return DEFAULT_BUCKETS.fineLabel(mult); }
