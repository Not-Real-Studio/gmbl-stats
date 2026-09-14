// Раскладка вкладки stats и агрегатные формулы: двойник aggregate.ts на языке Sheets, плюс
// витрина (dashboard / win distribution / combo) и запись statSummary / actual_*.
//
// Извлечено из sample-slot/src/stats-grid.js; всё, что было прибито к sample-slot (набор строк
// витрины, наборы распределения, раскладка), стало параметром.
//
// Формулы пишутся в авторском виде с разделителем `,` и локализуются под диалект документа
// (ru_RU → `;`). Десятичных литералов и строк с запятыми внутри быть не должно — глобальная
// замена их сломает.

import type { Bucket, Cell, ComboConfig, Dialect, Grid, PayableSymbol, Row, RowValue } from './types.ts';
import { DEFAULT_BUCKETS } from './buckets.ts';
import { payableSymbols } from './manifest.ts';
import { L_CONFIG_HASH, L_EWAGER, L_ROUNDS, L_STD, L_TIME } from './aggregate.ts';

// --- Раскладка -----------------------------------------------------------------------------

export interface Layout {
  /** Параметры последнего прогона: profile | mode | seed | spins | shards. */
  paramsRow: number;
  dash: { headerRow: number; firstRow: number };
  dist: { headerRow: number; subHeaderRow: number; firstRow: number };
  combo: { headerRow: number; subHeaderRow: number; firstRow: number };
  /** Маркеры колонок (`stat` над агрегатом и шардами). */
  metaRow: number;
  /** Шапка: label | АГРЕГАТ | 1 | 2 | … */
  headerRow: number;
  /** Инвалидация по хэшу конфига. */
  staleRow: number;
  stats: { firstRow: number; labelCol: number; aggCol: number; firstShardCol: number };
  summary: {
    metaRow: number; profileRow: number; modeRow: number; headerRow: number;
    firstRow: number; labelCol: number; firstKeyCol: number;
  };
  varTable: { metaCol: number; nameCol: number; commentCol: number; firstValueCol: number; headerRow: number };
}

export type LayoutOverrides = {
  [K in keyof Layout]?: Layout[K] extends number ? number : Partial<Layout[K]>;
};

// Дефолт — раскладка sample-slot: витрина (строки 1-99, человекочитаемые ссылки на агрегат) и сырьё
// (строки 200+, полный манифест + шарды).
const BASE_LAYOUT: Layout = {
  paramsRow: 1,
  dash: { headerRow: 3, firstRow: 4 },
  dist: { headerRow: 34, subHeaderRow: 35, firstRow: 36 },
  combo: { headerRow: 61, subHeaderRow: 62, firstRow: 63 },
  metaRow: 200,
  headerRow: 201,
  staleRow: 202,
  stats: { firstRow: 203, labelCol: 2, aggCol: 3, firstShardCol: 4 },
  summary: { metaRow: 1, profileRow: 2, modeRow: 3, headerRow: 4, firstRow: 5, labelCol: 2, firstKeyCol: 3 },
  varTable: { metaCol: 1, nameCol: 2, commentCol: 3, firstValueCol: 4, headerRow: 2 }
};

/** Раскладка с точечными правками поверх дефолта (вложенные группы мержатся по полям). */
export function makeLayout(overrides: LayoutOverrides = {}): Layout {
  const out = {
    paramsRow: BASE_LAYOUT.paramsRow,
    metaRow: BASE_LAYOUT.metaRow,
    headerRow: BASE_LAYOUT.headerRow,
    staleRow: BASE_LAYOUT.staleRow,
    dash: { ...BASE_LAYOUT.dash },
    dist: { ...BASE_LAYOUT.dist },
    combo: { ...BASE_LAYOUT.combo },
    stats: { ...BASE_LAYOUT.stats },
    summary: { ...BASE_LAYOUT.summary },
    varTable: { ...BASE_LAYOUT.varTable }
  } as Layout;
  const src = overrides as Record<string, unknown>;
  const dst = out as unknown as Record<string, unknown>;
  for (const k in src) {
    const v = src[k];
    if (typeof v === 'number') dst[k] = v;
    else if (v && typeof v === 'object') dst[k] = { ...(dst[k] as object), ...(v as object) };
  }
  return out;
}

/** Стандартная раскладка (дефолт всех функций грида). */
export const STAT_LAYOUT: Layout = makeLayout();

// --- Мелочи --------------------------------------------------------------------------------

export function statsStr(v: Cell): string { return v == null ? '' : String(v); }
export function statsIsEmpty(v: Cell): boolean { return v == null || v === ''; }

/** 1-based номер колонки → имя ('A', 'B', … 'AA'). */
export function statsColName(n: number): string {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}

/**
 * Авторская формула (`,`) → диалект документа (ru_RU `;`). Строковых литералов с запятыми в
 * генерируемых формулах нет — глобальная замена безопасна.
 */
export function statsLocalizeFormula(formula: string, dialect?: Dialect): string {
  const sep = (dialect && dialect.formulaArg) || ';';
  return sep === ',' ? formula : formula.split(',').join(sep);
}

// Индекс «лейбл → строка сырья» (1-based) с громкой ошибкой на промах: лейбла нет в манифесте —
// это опечатка витрины или разъехавшийся манифест, а не повод молча пропустить ячейку.
function rowIndex(rows: Row[], layout: Layout): (label: string | null, why: string) => number {
  const rowOf: Record<string, number> = {};
  for (let i = 0; i < rows.length; i++) rowOf[(rows[i] as Row).label] = layout.stats.firstRow + i;
  return function need(label: string | null, why: string): number {
    const r = label == null ? undefined : rowOf[label];
    if (!r) throw new Error('stats: в манифесте нет строки «' + label + '» (' + why + ')');
    return r;
  };
}

// --- Агрегатные формулы --------------------------------------------------------------------

/**
 * Формулы агрегатной колонки по манифесту (одно правило — одна формула; кодовый двойник —
 * aggregateRows). Возвращает массив формул в порядке строк; секции — пустая строка.
 */
export function statsAggregateFormulas(rows: Row[], shards: number, layout: Layout = STAT_LAYOUT): string[] {
  const L = layout.stats;
  const first = statsColName(L.firstShardCol);
  const last = statsColName(L.firstShardCol + Math.max(1, shards) - 1);
  const AGG = statsColName(L.aggCol);

  const need = rowIndex(rows, layout);
  function range(r: number): string { return first + r + ':' + last + r; }
  function abs(r: number): string { return '$' + first + '$' + r + ':$' + last + '$' + r; }
  function cell(label: string | null, why: string): string { return AGG + need(label, why); }

  const N = abs(need(L_ROUNDS, 'вес агрегации'));
  const sumN = 'SUM(' + N + ')';

  const out: string[] = [];
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k] as Row;
    const r = L.firstRow + k;
    switch (row.agg) {
      case 'section': out.push(''); break;
      case 'sum': out.push('=SUM(' + range(r) + ')'); break;
      // пустой прогон → пусто (а не MAX пустого диапазона = 0): единый признак «данных нет»
      case 'max': out.push('=IF(' + sumN + '=0,"",MAX(' + range(r) + '))'); break;
      case 'text': case 'date':
        // первое непустое значение шардов: provenance агрегата
        out.push('=IFERROR(INDEX(FILTER(' + range(r) + ',' + range(r) + '<>""),1),"")');
        break;
      case 'wavg':
        out.push('=IF(' + sumN + '=0,"",SUMPRODUCT(' + N + ',' + range(r) + ')/' + sumN + ')');
        break;
      case 'std': {
        // пул: √( (Σ N·σ² + Σ N·μ²)/ΣN − μ_агг² ). SUMPRODUCT трёх диапазонов вместо степени —
        // надёжнее в Sheets и читается однозначно.
        const mu = range(need(row.of, 'μ для пула STD'));
        const s = range(r);
        const mAgg = cell(row.of, 'μ агрегата');
        out.push('=IF(' + sumN + '=0,"",SQRT(MAX(0,(SUMPRODUCT(' + N + ',' + s + ',' + s + ')+SUMPRODUCT(' +
          N + ',' + mu + ',' + mu + '))/' + sumN + '-' + mAgg + '*' + mAgg + ')))');
        break;
      }
      case 'speed': {
        const t = cell(L_TIME, 'Speed');
        out.push('=IF(' + t + '=0,"",' + cell(L_ROUNDS, 'Speed') + '/' + t + ')');
        break;
      }
      case 'noise': {
        const nCell = cell(L_ROUNDS, 'noise floor');
        out.push('=IF(' + nCell + '=0,"",2*' + cell(L_STD, 'noise floor') + '*100/SQRT(' + nCell + '))');
        break;
      }
      case 'rtp': {
        const wg = cell(L_EWAGER, 'знаменатель RTP');
        out.push('=IF(' + wg + '=0,"",' + cell(row.of, row.label) + '/' + wg + '*100)');
        break;
      }
      case 'share': {
        const nc = cell(L_ROUNDS, row.label);
        out.push('=IF(' + nc + '=0,"",' + cell(row.of, row.label) + '/' + nc + '*100)');
        break;
      }
      case 'pct': {
        const pc = cell(row.per, row.label);
        out.push('=IF(' + pc + '=0,"",' + cell(row.of, row.label) + '/' + pc + '*100)');
        break;
      }
      case 'ratio': {
        const pr = cell(row.per, row.label);
        out.push('=IF(' + pr + '=0,"",' + cell(row.of, row.label) + '/' + pr + ')');
        break;
      }
      case 'one_in': {
        const oc = cell(row.of, row.label);
        out.push('=IF(' + oc + '=0,"",' + cell(row.per || L_ROUNDS, row.label) + '/' + oc + ')');
        break;
      }
      default:
        throw new Error('stats: неизвестное правило агрегации «' + (row as Row).agg +
          '» (строка «' + (row as Row).label + '»)');
    }
  }
  return out;
}

/**
 * Формулы строки инвалидации: хэш конфига шарда против хэша, записанного при init.
 * Протухшая колонка обязана кричать, а не молчать.
 */
export function statsStaleFormulas(rows: Row[], shards: number, layout: Layout = STAT_LAYOUT): string[] {
  const L = layout.stats;
  let hashRow = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i] as Row).label === L_CONFIG_HASH) hashRow = L.firstRow + i;
  }
  if (hashRow < 0) {
    throw new Error('stats: в манифесте нет строки «' + L_CONFIG_HASH + '» — инвалидацию не на чем строить');
  }
  const cur = '$' + statsColName(L.aggCol) + '$' + layout.staleRow;
  const out: string[] = [];
  for (let c = 0; c < shards; c++) {
    const col = statsColName(L.firstShardCol + c);
    out.push('=IF(' + col + hashRow + '="","",IF(' + col + hashRow + '=' + cur + ',"ok","ПРОТУХЛА"))');
  }
  return out;
}

export interface Skeleton {
  /** Лейблы манифеста колонкой (для setValues). */
  labels: string[][];
  /** Агрегатные формулы колонкой, локализованные под диалект. */
  formulas: string[][];
  /** Маркеры колонок: агрегат + шарды. */
  meta: string[];
  /** Шапка колонок: АГРЕГАТ | 1 | 2 | … */
  header: Array<string | number>;
  /** Строка инвалидации: хэш init в агрегате + формулы сверки по шардам. */
  stale: string[];
}

/** Скелет вкладки stats: пишется ОДИН раз (init), а не каждым шардом. */
export function statsSkeleton(
  rows: Row[], shards: number, dialect?: Dialect, configHashValue?: string | null, layout: Layout = STAT_LAYOUT
): Skeleton {
  const labels: string[][] = [], formulas: string[][] = [], meta: string[] = [];
  const header: Array<string | number> = [], stale: string[] = [];
  const f = statsAggregateFormulas(rows, shards, layout);
  for (let i = 0; i < rows.length; i++) {
    labels.push([(rows[i] as Row).label]);
    const formula = f[i] as string;
    formulas.push([formula ? statsLocalizeFormula(formula, dialect) : '']);
  }
  meta.push('stat'); // колонка агрегата
  header.push('АГРЕГАТ');
  stale.push(configHashValue == null ? '' : configHashValue);
  const sf = statsStaleFormulas(rows, shards, layout);
  for (let c = 0; c < shards; c++) {
    meta.push('stat');
    header.push(c + 1);
    stale.push(statsLocalizeFormula(sf[c] as string, dialect));
  }
  return { labels, formulas, meta, header, stale };
}

/** Значения колонки-шарда: производные строки остаются пустыми — их считает агрегат. */
export function statsShardValues(rows: Array<{ value: RowValue }>): Array<[string | number]> {
  const out: Array<[string | number]> = [];
  for (let i = 0; i < rows.length; i++) {
    const v = (rows[i] as { value: RowValue }).value;
    out.push([v === null || v === undefined ? '' : v]);
  }
  return out;
}

// --- Витрина -------------------------------------------------------------------------------
// Презентационный слой ПОВЕРХ сырья: каждая ячейка — простая ссылка `=C{строка сырья}` на
// агрегатную колонку манифеста. Функции чистые, шит не трогают.

/** label → формула-ссылка на агрегатную ячейку сырья этого лейбла. */
export function statsVitrineRef(rows: Row[], layout: Layout = STAT_LAYOUT): (label: string, why: string) => string {
  const AGG = statsColName(layout.stats.aggCol);
  const need = rowIndex(rows, layout);
  return function ref(label: string, why: string): string { return '=' + AGG + need(label, why); };
}

/** Строка витрины: лейбл манифеста, пара [заголовок, лейбл] или null — визуальный разделитель. */
export type DashboardLabel = string | [string, string] | null;

/** Dashboard: [[заголовок, формула], …]; пустая пара — визуальный разделитель. */
export function dashboardContent(
  rows: Row[], labels: DashboardLabel[], layout: Layout = STAT_LAYOUT
): Array<[string, string]> {
  const ref = statsVitrineRef(rows, layout);
  const out: Array<[string, string]> = [];
  for (let i = 0; i < labels.length; i++) {
    const spec = labels[i] as DashboardLabel;
    if (!spec) { out.push(['', '']); continue; }
    const title = typeof spec === 'string' ? spec : spec[0];
    const label = typeof spec === 'string' ? spec : spec[1];
    out.push([title, ref(label, 'dashboard: ' + title)]);
  }
  return out;
}

/** Набор колонок распределения: имя блока манифеста + знаменатель доли (лейбл строки). */
export interface DistSet {
  /** Имя набора в манифесте: `hist {name} …`. */
  name: string;
  /** Лейбл строки-знаменателя для «%» (дефолт Rounds). */
  per?: string;
}

/**
 * Win distribution: [[лейбл бакета, %набор1, %RTP набор1, %набор2, …], …].
 * «%» = N/знаменатель*100 (для FG знаменатель обычно триггеры — это % сессий, не спинов).
 * Формулы содержат IF → нуждаются в локализации на стороне init.
 */
export function distributionContent(
  rows: Row[],
  sets: DistSet[],
  buckets: Bucket[] | string[] = DEFAULT_BUCKETS.buckets(),
  layout: Layout = STAT_LAYOUT
): Array<Array<string>> {
  const AGG = statsColName(layout.stats.aggCol);
  const need = rowIndex(rows, layout);
  function cell(label: string, why: string): string { return AGG + need(label, why); }
  const out: string[][] = [];
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i] as Bucket | string;
    const lb = typeof b === 'string' ? b : b.label;
    const why = 'dist ' + lb;
    const line: string[] = [lb];
    for (let s = 0; s < sets.length; s++) {
      const set = sets[s] as DistSet;
      const per = cell(set.per || L_ROUNDS, why);
      line.push('=IF(' + per + '=0,"",' + cell('hist ' + set.name + ' ' + lb + ' N', why) + '/' + per + '*100)');
      line.push('=' + cell('hist ' + set.name + ' ' + lb + ' %RTP', why));
    }
    out.push(line);
  }
  return out;
}

/** Combo %RTP: [[«name Nof», %RTP набор1, %RTP набор2, …], …] по платящим символам × длинам. */
export function comboContent(
  rows: Row[], config: ComboConfig, sets: string[], layout: Layout = STAT_LAYOUT
): Array<Array<string>> {
  const ref = statsVitrineRef(rows, layout);
  const syms = payableSymbols(config);
  const out: string[][] = [];
  for (let i = 0; i < syms.length; i++) {
    const sym = syms[i] as PayableSymbol;
    for (let k = 0; k < sym.lens.length; k++) {
      const len = sym.lens[k] as number;
      const why = 'combo: ' + sym.name + ' ' + len + 'of';
      const line: string[] = [sym.name + ' ' + len + 'of'];
      for (let s = 0; s < sets.length; s++) {
        line.push(ref('combo ' + (sets[s] as string) + ' ' + sym.name + ' ' + len + 'of %RTP', why));
      }
      out.push(line);
    }
  }
  return out;
}

// --- statSummary ---------------------------------------------------------------------------

/**
 * Оверврайт колонки по ключу профиль × режим. Ключ совпал — колонка чистится и пишется целиком;
 * не совпал — новая справа. Запись ПО ЛЕЙБЛУ строки (лейбл-колонка summary — мастер):
 * перестановка строк манифеста данные не портит.
 */
export function statsUpsertSummaryColumn(
  grid: Grid,
  key: { profile: string; mode: string },
  rows: Array<{ label: string; value: RowValue }>,
  layout: Layout = STAT_LAYOUT
): { grid: Grid; col: number } {
  const S = layout.summary;
  function ensureRow(r: number): Cell[] {
    while (grid.length <= r) grid.push([]);
    if (!grid[r]) grid[r] = [];
    return grid[r] as Cell[];
  }
  function at(r: number, c: number): Cell {
    const row = grid[r];
    return row ? row[c] : undefined;
  }
  function set(r: number, c: number, v: Cell): void {
    const row = ensureRow(r);
    while (row.length <= c) row.push('');
    row[c] = v;
  }
  let width = 0;
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    if (row && row.length > width) width = row.length;
  }

  ensureRow(S.profileRow - 1); ensureRow(S.modeRow - 1); ensureRow(S.headerRow - 1);
  set(S.profileRow - 1, S.labelCol - 1, 'profile');
  set(S.modeRow - 1, S.labelCol - 1, 'mode');
  set(S.headerRow - 1, S.labelCol - 1, 'label');

  let col = -1;
  for (let c = S.firstKeyCol - 1; c < width; c++) {
    if (statsStr(at(S.profileRow - 1, c)) === key.profile && statsStr(at(S.modeRow - 1, c)) === key.mode) {
      col = c; break;
    }
  }
  if (col === -1) {
    col = S.firstKeyCol - 1;
    for (let c2 = S.firstKeyCol - 1; c2 < width; c2++) {
      if (!statsIsEmpty(at(S.profileRow - 1, c2)) || !statsIsEmpty(at(S.modeRow - 1, c2))) col = c2 + 1;
    }
  }

  // Индекс строк по лейблу; служебные и комментарии в индекс не берём.
  const rowOf: Record<string, number> = {};
  for (let r = S.firstRow - 1; r < grid.length; r++) {
    const mk = statsStr(at(r, layout.varTable.metaCol - 1));
    if (mk === '//' || mk === '-') continue;
    const lb = statsStr(at(r, S.labelCol - 1));
    if (lb !== '') rowOf[lb] = r;
  }
  for (let k = 0; k < rows.length; k++) {
    const label = (rows[k] as { label: string }).label;
    if (rowOf[label] === undefined) {
      const nr = Math.max(grid.length, S.firstRow - 1);
      set(nr, S.labelCol - 1, label);
      rowOf[label] = nr;
    }
  }

  // Полный оверврайт колонки: чистим, потом пишем — иначе строки прошлого прогона этой
  // комбинации остались бы висеть (данные от другого конфига под тем же ключом).
  for (let rr = S.firstRow - 1; rr < grid.length; rr++) set(rr, col, '');
  set(S.metaRow - 1, col, 'stat');
  set(S.profileRow - 1, col, key.profile);
  set(S.modeRow - 1, col, key.mode);
  for (let q = 0; q < rows.length; q++) {
    const r = rows[q] as { label: string; value: RowValue };
    set(rowOf[r.label] as number, col, r.value === null || r.value === undefined ? '' : r.value);
  }
  return { grid, col: col + 1 };
}

/**
 * 1-based строка грида по лейблу в колонке лейблов (или -1). Адрес считается по лейблу, а не по
 * позиции: порядок строк задаёт манифест и он может поменяться.
 */
export function statsFindLabelRow(grid: Grid, labelCol: number, label: string): number {
  for (let r = 0; r < grid.length; r++) {
    const row = (grid[r] || []) as Cell[];
    if (statsStr(row[labelCol - 1]) === label) return r + 1;
  }
  return -1;
}

// --- Врайтбек actual_* в profiles ----------------------------------------------------------

export interface ActualWrite { key: string; row: number; col: number; value: Cell }

/**
 * План адресных записей [{key,row,col,value}] (1-based). Ничего не мутирует.
 * Отсутствие колонки профиля или строки actual_* — ГРОМКАЯ ОШИБКА: тихий скип derived-записи —
 * root cause потери actual_-данных.
 */
export function statsPlanProfileActuals(
  grid: Grid, profileName: string, values: Record<string, Cell>, layout: Layout = STAT_LAYOUT
): ActualWrite[] {
  const V = layout.varTable;
  let width = 0;
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    if (row && row.length > width) width = row.length;
  }

  // Строка-шапка профилей: ищем по литералу var_name в колонке имён (сдвиги строк переживает).
  let headerRow = -1;
  for (let r = 0; r < grid.length; r++) {
    if (statsStr(((grid[r] || []) as Cell[])[V.nameCol - 1]).trim() === 'var_name') { headerRow = r; break; }
  }
  if (headerRow < 0) {
    throw new Error('profiles: не найдена строка-шапка (var_name в колонке имён) — врайтбеку некуда целиться');
  }

  let col = -1;
  const have: string[] = [];
  for (let c = V.firstValueCol - 1; c < width; c++) {
    const n = statsStr(((grid[headerRow] || []) as Cell[])[c]).trim();
    if (n !== '') have.push(n);
    if (n === profileName) { col = c; break; }
  }
  if (col === -1) {
    throw new Error('profiles: колонка профиля «' + profileName + '» не найдена (строка ' +
      (headerRow + 1) + '). Есть: ' + (have.join(', ') || '—'));
  }

  const rowOf: Record<string, number> = {};
  for (let rr = headerRow + 1; rr < grid.length; rr++) {
    const name = statsStr(((grid[rr] || []) as Cell[])[V.nameCol - 1]).trim();
    if (name !== '') rowOf[name] = rr;
  }
  const missing: string[] = [], keys: string[] = [];
  for (const k in values) { keys.push(k); if (rowOf[k] === undefined) missing.push(k); }
  if (missing.length) {
    throw new Error('profiles: нет обязательных строк врайтбека: ' + missing.join(', ') +
      '. Строка обязана существовать в шаблоне — тихий скип запрещён.');
  }
  const plan: ActualWrite[] = [];
  for (let q = 0; q < keys.length; q++) {
    const k = keys[q] as string;
    plan.push({ key: k, row: (rowOf[k] as number) + 1, col: col + 1, value: values[k] });
  }
  return plan;
}

/** Врайтбек в грид (node-путь: зеркало — данные, формулы в соседних ячейках не трогаем). */
export function statsWriteProfileActuals(
  grid: Grid, profileName: string, values: Record<string, Cell>, layout: Layout = STAT_LAYOUT
): Grid {
  const plan = statsPlanProfileActuals(grid, profileName, values, layout);
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i] as ActualWrite;
    const row = grid[p.row - 1] as Cell[];
    while (row.length < p.col) row.push('');
    row[p.col - 1] = p.value;
  }
  return grid;
}

/**
 * Канонический вид грида для зеркала: дырки и null → '', хвостовые пустые ячейки обрезаны.
 * Ровно это делает normalizeGrid в sheet-mirror — файл, записанный иначе, даёт вечный шум
 * в диффах после первого же pull.
 */
export function statsTrimTrailing(grid: Grid): Grid {
  const out: Grid = [];
  for (let r = 0; r < grid.length; r++) {
    const row = (grid[r] || []) as Cell[];
    const line: Cell[] = [];
    for (let c = 0; c < row.length; c++) line.push(row[c] === undefined || row[c] === null ? '' : row[c]);
    while (line.length > 0 && line[line.length - 1] === '') line.pop();
    out.push(line);
  }
  return out;
}

/** Прямоугольный грид без дырок (разреженные строки не сериализуются в TOON). */
export function statsRectangular(grid: Grid): Grid {
  let w = 0;
  const out: Grid = [];
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    if (row && row.length > w) w = row.length;
  }
  for (let r = 0; r < grid.length; r++) {
    const row = (grid[r] || []) as Cell[];
    const line: Cell[] = [];
    for (let c = 0; c < w; c++) line.push(row[c] === undefined || row[c] === null ? '' : row[c]);
    out.push(line);
  }
  return out;
}
