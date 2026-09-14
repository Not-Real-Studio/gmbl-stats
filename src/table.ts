// table — шардинг и раскладка вкладки ПОВЕРХ SheetPort (§9 спеки).
//
// Однописатель: prepareRun → N×computeShard → writeRun → commitSummary → writeActuals.
// Публичные имена с префиксом `stats` (как в grid.ts): в GAS они становятся глобальными.
//
// Схема sample-app, вычищенная от трёх её болезней (см. stats-basis-manifest §3):
//   1. Лейблы и агрегатные формулы пишет prepareRun ОДИН раз, а не каждый шард.
//   2. Агрегат взвешен по Rounds (у колонок разные N), а не AVERAGE.
//   3. Шард не делает врайтбек своими локальными числами — врайтбек поверх агрегата.
// Плюс урок NOT-255: параллельные исполнения, пишущие один шит, теряют записи даже под локом —
// GAS применяет мутации к ревизии документа, открытой на старте исполнения. Поэтому
// `statsComputeShard` — ЧИСТЫЙ счётчик (порта не касается вообще), а пишет всё один вызов
// `statsWriteRun`. Параллельность остаётся: счёт идёт в K независимых исполнениях.
//
// Game-specific остаётся у игры и приезжает через StatsAdapter: сборка конфига, запуск раунда,
// аккумуляция, состав манифеста, состав витрины, какие поля идут в хэш и во врайтбек.

import type { Bucket, Cell, ComboConfig, Dialect, Grid, Provenance, Row, RowValue, Stats } from './types.ts';
import type { SheetPort, Style } from './port.ts';
import { portGrid } from './port.ts';
import { configHash } from './hash.ts';
import { rowsByLabel, L_CONFIG_HASH, L_DATE, L_EWAGER, L_EWIN, L_MODE, L_PROFILE, L_ROUNDS, L_RTP } from './aggregate.ts';
import {
  STAT_LAYOUT, comboContent, dashboardContent, distributionContent, statsFindLabelRow,
  statsLocalizeFormula, statsRectangular, statsShardValues, statsSkeleton, statsUpsertSummaryColumn,
  statsPlanProfileActuals
} from './grid.ts';
import type { DashboardLabel, DistSet, Layout } from './grid.ts';

// --- Адаптер игры ----------------------------------------------------------------------------

/** Результат сборки конфига: сам конфиг + разрешённое имя профиля (и список профилей для панели). */
export interface BuiltConfig {
  config: Record<string, unknown>;
  profileName: string;
  profiles?: string[];
}

/** Ответ движка игры на один раунд (форма — дело игры, ядро его только передаёт в accumulate). */
export type RoundResult = unknown;

/**
 * Контракт игры перед table-слоем. Всё, что здесь есть, — то, что действительно различается
 * между слотами; всё остальное (адреса, формулы, агрегация, слияние, врайтбек) делает ядро.
 */
export interface StatsAdapter {
  /** Конфиг по имени профиля (null = профиль по умолчанию документа). */
  buildConfig(profileName?: string | null): BuiltConfig;
  /** Пустой аккумулятор игры: `{...baseStats(), …}`. */
  newStats(): Stats;
  /** Один раунд движка. */
  playRound(config: Record<string, unknown>, opts: Record<string, unknown>): RoundResult;
  /** Аккумуляция раунда (первой строкой зовёт accumulateBase ядра). */
  accumulate(st: Stats, round: RoundResult, config: Record<string, unknown>): void;
  /** Манифест: состав и порядок строк (пустой st даёт скелет для init). */
  manifest(st: Stats, config: Record<string, unknown>, prov: Provenance): Row[];
  /** Поля конфига, входящие в хэш (game-specific). Либо готовый configHash. */
  snapshot?(config: Record<string, unknown>): unknown;
  configHash?(config: Record<string, unknown>): string;
  /** Опции движка по режиму панели (например {forceFeature: 6}). */
  modeOpts?(mode: string): Record<string, unknown>;
  /** Сид раунда i внутри шарда. Дефолт — `(seed ^ (i * 0x9e3779b1)) | 0`. */
  roundSeed?(seed: number, i: number): number;
  /** Диалект документа. Дефолт — `config.dialect`. */
  dialect?(config: Record<string, unknown>): Dialect | undefined;
  /** Витрина: строки dashboard, наборы распределения, наборы combo. */
  dashboard?: DashboardLabel[];
  distSets?: DistSet[];
  /** Шапка распределения; дефолт — `['Label', '{name} %', '{name} %RTP', …]`. */
  distHeader?: string[];
  /**
   * Бакеты распределения для ВИТРИНЫ. Игра со своей лестницей обязана его дать: витрина
   * ссылается на строки манифеста по лейблу бакета, и дефолтные бакеты ядра дали бы ссылки
   * на несуществующие строки. Не задан — дефолтная лестница ядра.
   */
  buckets?(config: Record<string, unknown>): Bucket[] | string[];
  comboSets?: string[];
  /** Срез конфига для combo-витрины; дефолт — сам конфиг (`{symbols, paytable}`). */
  comboConfig?(config: Record<string, unknown>): ComboConfig | null;
  /** Значения врайтбека actual_* из агрегата (какие строки у игры есть — знает игра). */
  actuals?(by: Record<string, RowValue>, ctx: ActualsContext): Record<string, Cell>;
  /** Дефолты панели. */
  defaults?: { rounds?: number; shards?: number; seed?: number; modes?: string[] };
}

export interface ActualsContext { mode: string; hash: string; date: number; profile: string }

// --- Опции table-слоя ------------------------------------------------------------------------

export interface SheetNames { stats: string; summary: string; profiles: string }

export interface TableStyles {
  params?: Style;
  sectionHeader?: Style;
  subHeader?: Style;
  rawHeader?: Style;
  meta?: Style;
  label?: Style;
  /** Ширины колонок вкладки stats, начиная с колонки 1. */
  colWidths?: number[];
}

export interface TableOptions {
  layout?: Layout;
  sheets?: Partial<SheetNames>;
  /** Оформление вкладки. `false` — не форматировать вообще (чистые значения). */
  styles?: TableStyles | false;
  /** Заголовки блоков витрины. */
  titles?: { dashboard?: string; distribution?: string; combo?: string };
  /** Какие ключи врайтбека — даты (им ставится числовой формат). Дефолт: `actual_date*`. */
  isDateKey?: (key: string) => boolean;
}

export const DEFAULT_SHEETS: SheetNames = { stats: 'stats', summary: 'statSummary', profiles: 'profiles' };

/** Кодифицированный вид вкладки: во всех слотах одинаковый (§8, сценарий 3). */
export const DEFAULT_STYLES: TableStyles = {
  params: { bg: '#f1f3f4', bold: true },
  sectionHeader: { bg: '#d9e2f3', bold: true },
  subHeader: { bold: true },
  rawHeader: { bg: '#e8eaed', bold: true },
  meta: { fontColor: '#999999' },
  label: {},
  colWidths: [260, 320, 120]
};

const DEFAULT_TITLES = { dashboard: '— Dashboard —', distribution: '— Win Distribution —', combo: '— Combo %RTP —' };

function sheetsOf(opts: TableOptions): SheetNames { return { ...DEFAULT_SHEETS, ...(opts.sheets || {}) }; }
function layoutOf(opts: TableOptions): Layout { return opts.layout || STAT_LAYOUT; }
function stylesOf(opts: TableOptions): TableStyles | null {
  if (opts.styles === false) return null;
  return { ...DEFAULT_STYLES, ...(opts.styles || {}) };
}

// --- Мелочи ----------------------------------------------------------------------------------

/** Google serial-дата (дни с 1899-12-30). Числом, не строкой: строковая дата в шите датой не станет. */
export function statsSerialDate(ms?: number): number {
  return ((ms === undefined ? Date.now() : ms) / 86400000) + 25569;
}

/**
 * Хэш конфига по адаптеру: снапшот игры + раскладка манифеста (лейблы строк скелета).
 *
 * Раскладка входит в хэш, потому что лейблы бакетов — часть адресации сохранённых колонок:
 * смена лестницы Win Distribution не меняет ни одного поля конфига, но кладёт числа другой
 * сетки в колонку старой. Скелет берётся тем же вызовом, что и в statsPrepareRun.
 */
export function statsConfigHash(adapter: StatsAdapter, config: Record<string, unknown>): string {
  let game: unknown;
  if (adapter.configHash) game = adapter.configHash(config);
  else if (adapter.snapshot) game = adapter.snapshot(config);
  else throw new Error('table: адаптер обязан дать snapshot(config) или configHash(config) — инвалидация колонок без хэша невозможна');
  const rows = adapter.manifest(adapter.newStats(), config, {});
  const dist: string[] = [];
  for (let i = 0; i < rows.length; i++) dist.push((rows[i] as Row).label);
  return configHash({ game, dist });
}

function dialectOf(adapter: StatsAdapter, config: Record<string, unknown>): Dialect | undefined {
  if (adapter.dialect) return adapter.dialect(config);
  return config['dialect'] as Dialect | undefined;
}

function str(v: Cell): string { return v === null || v === undefined ? '' : String(v); }

/** 1-based строка вкладки для лейбла манифеста, или -1. */
export function statsManifestRow(rows: Row[], label: string, layout: Layout = STAT_LAYOUT): number {
  for (let i = 0; i < rows.length; i++) if ((rows[i] as Row).label === label) return layout.stats.firstRow + i;
  return -1;
}

function localizeGrid(grid: Grid, dialect: Dialect | undefined): Grid {
  const out: Grid = [];
  for (let r = 0; r < grid.length; r++) {
    const line = (grid[r] || []) as Cell[];
    const dst: Cell[] = [];
    for (let c = 0; c < line.length; c++) {
      const v = line[c];
      dst.push(typeof v === 'string' && v.charAt(0) === '=' ? statsLocalizeFormula(v, dialect) : v);
    }
    out.push(dst);
  }
  return out;
}

// --- Параметры прогона -----------------------------------------------------------------------

export interface RunParams {
  profile?: string | null;
  mode?: string;
  rounds?: number;
  seed?: number;
  shards?: number;
}

/** Строка параметров последнего прогона (видна без открытия панели). */
export interface SavedParams { profile?: string; mode?: string; seed?: number; spins?: number; shards?: number }

function paramsRowValues(profile: string, mode: string, params: RunParams): Cell[] {
  return ['profile', profile, 'mode', mode,
    'seed', params.seed === undefined || params.seed === null ? '' : params.seed,
    'spins', params.rounds === undefined || params.rounds === null ? '' : params.rounds,
    'shards', params.shards === undefined ? '' : params.shards];
}

/** Прочитать строку параметров (для панели). Вкладки/строки нет — null. */
export function statsReadParams(port: SheetPort, opts: TableOptions = {}): SavedParams | null {
  const layout = layoutOf(opts), sheets = sheetsOf(opts);
  let size;
  try { size = port.size(sheets.stats); } catch { return null; }
  if (size.rows < layout.paramsRow || size.cols < 10) return null;
  const r = (port.read(sheets.stats, layout.paramsRow, 1, 1, 10)[0] || []) as Cell[];
  if (str(r[0]) !== 'profile') return null;
  const out: SavedParams = {};
  if (r[1]) out.profile = str(r[1]);
  if (r[3]) out.mode = str(r[3]);
  if (r[5]) out.seed = Number(r[5]) || undefined;
  if (r[7]) out.spins = Number(r[7]) || undefined;
  if (r[9]) out.shards = Number(r[9]) || undefined;
  return out;
}

// --- prepareRun: init вкладки ----------------------------------------------------------------

export interface InitResult { rows: number; shards: number; hash: string; profile: string; mode: string }

/**
 * Init вкладки stats под комбинацию: витрина (простые ссылки `=C{сырьё}` на агрегат) + сырьё
 * (лейблы манифеста, агрегатные формулы, шапка колонок, строка инвалидации по хэшу).
 * ВСЕГДА пересобирает вкладку: stats — рабочая поверхность ОДНОГО прогона, архив — statSummary.
 * Старые колонки-шардов стираются: иначе в агрегат попадут числа от другой комбинации (болезнь
 * sample-app — колонки разных профилей молча смешивались).
 *
 * Лок (в GAS — LockService) снаружи: table-слой о рантайме не знает.
 */
export function statsPrepareRun(
  port: SheetPort, adapter: StatsAdapter, params: RunParams = {}, opts: TableOptions = {}
): InitResult {
  const layout = layoutOf(opts), sheets = sheetsOf(opts), styles = stylesOf(opts);
  const titles = { ...DEFAULT_TITLES, ...(opts.titles || {}) };
  const L = layout.stats;

  const shards = Math.max(1, Math.floor(Number(params.shards)) || 1);
  const mode = params.mode || 'base';
  const built = adapter.buildConfig(params.profile);
  const config = built.config;
  const dialect = dialectOf(adapter, config);
  const rows = adapter.manifest(adapter.newStats(), config, {});
  const hash = statsConfigHash(adapter, config);
  const skeleton = statsSkeleton(rows, shards, dialect, hash, layout);

  port.ensureSheet(sheets.stats);
  port.clear(sheets.stats);

  // строка параметров
  port.write(sheets.stats, layout.paramsRow, 1, [paramsRowValues(built.profileName, mode, { ...params, shards })]);

  // --- витрина ---
  if (adapter.dashboard && adapter.dashboard.length) {
    const dash = dashboardContent(rows, adapter.dashboard, layout);
    port.write(sheets.stats, layout.dash.headerRow, 1, [[titles.dashboard]]);
    port.write(sheets.stats, layout.dash.firstRow, 1, dash.map((d) => [d[0]]));
    port.write(sheets.stats, layout.dash.firstRow, L.aggCol,
      localizeGrid(dash.map((d) => [d[1]]), dialect));
  }
  if (adapter.distSets && adapter.distSets.length) {
    const bks = adapter.buckets ? adapter.buckets(config) : undefined;
    const dist = localizeGrid(distributionContent(rows, adapter.distSets, bks, layout), dialect);
    const header = adapter.distHeader || distHeaderOf(adapter.distSets);
    port.write(sheets.stats, layout.dist.headerRow, 1, [[titles.distribution]]);
    port.write(sheets.stats, layout.dist.subHeaderRow, 1, [header]);
    port.write(sheets.stats, layout.dist.firstRow, 1, dist);
  }
  if (adapter.comboSets && adapter.comboSets.length) {
    const comboCfg = adapter.comboConfig ? adapter.comboConfig(config) : (config as unknown as ComboConfig);
    if (comboCfg) {
      const combo = localizeGrid(comboContent(rows, comboCfg, adapter.comboSets, layout), dialect);
      port.write(sheets.stats, layout.combo.headerRow, 1, [[titles.combo]]);
      port.write(sheets.stats, layout.combo.subHeaderRow, 1, [['Symbol × Length' as Cell].concat(adapter.comboSets)]);
      port.write(sheets.stats, layout.combo.firstRow, 1, combo);
    }
  }

  // --- сырьё ---
  port.write(sheets.stats, layout.metaRow, L.aggCol, [skeleton.meta]);
  port.write(sheets.stats, layout.headerRow, L.labelCol, [['label']]);
  port.write(sheets.stats, layout.headerRow, L.aggCol, [skeleton.header]);
  port.write(sheets.stats, layout.staleRow, L.labelCol, [['config_hash (init) / протухание']]);
  port.write(sheets.stats, layout.staleRow, L.aggCol, [skeleton.stale]);
  port.write(sheets.stats, L.firstRow, L.labelCol, skeleton.labels);
  port.write(sheets.stats, L.firstRow, L.aggCol, skeleton.formulas);

  // дата provenance приезжает serial-числом; датой её делает числовой формат
  const dateRow = statsManifestRow(rows, L_DATE, layout);
  if (dateRow > 0 && dialect && dialect.date) {
    port.format(sheets.stats, dateRow, L.aggCol, 1, shards + 1, { numberFormat: dialect.date });
  }

  if (styles) applyInitStyles(port, sheets.stats, layout, styles, shards, rows.length, adapter);

  port.flush();
  return { rows: rows.length, shards, hash, profile: built.profileName, mode };
}

function distHeaderOf(sets: DistSet[]): string[] {
  const out: string[] = ['Label'];
  for (let i = 0; i < sets.length; i++) {
    const name = (sets[i] as DistSet).name;
    out.push(name + ' %', name + ' %RTP');
  }
  return out;
}

function applyInitStyles(
  port: SheetPort, sheet: string, layout: Layout, styles: TableStyles, shards: number,
  manifestRows: number, adapter: StatsAdapter
): void {
  const L = layout.stats;
  const width = L.firstShardCol + shards - 1;
  if (styles.params) port.format(sheet, layout.paramsRow, 1, 1, 10, styles.params);
  if (styles.sectionHeader) {
    if (adapter.dashboard && adapter.dashboard.length) {
      port.format(sheet, layout.dash.headerRow, 1, 1, Math.max(3, width), styles.sectionHeader);
    }
    if (adapter.distSets && adapter.distSets.length) {
      port.format(sheet, layout.dist.headerRow, 1, 1, Math.max(3, width), styles.sectionHeader);
      if (styles.subHeader) port.format(sheet, layout.dist.subHeaderRow, 1, 1, 1 + adapter.distSets.length * 2, styles.subHeader);
    }
    if (adapter.comboSets && adapter.comboSets.length) {
      port.format(sheet, layout.combo.headerRow, 1, 1, Math.max(3, width), styles.sectionHeader);
      if (styles.subHeader) port.format(sheet, layout.combo.subHeaderRow, 1, 1, 1 + adapter.comboSets.length, styles.subHeader);
    }
  }
  if (styles.meta) {
    port.format(sheet, layout.metaRow, L.labelCol, 1, width - L.labelCol + 1, styles.meta);
    port.format(sheet, layout.staleRow, L.labelCol, 1, width - L.labelCol + 1, styles.meta);
  }
  if (styles.rawHeader) port.format(sheet, layout.headerRow, L.labelCol, 1, width - L.labelCol + 1, styles.rawHeader);
  if (styles.label && manifestRows > 0 && hasStyle(styles.label)) {
    port.format(sheet, L.firstRow, L.labelCol, manifestRows, 1, styles.label);
  }
  if (styles.colWidths && styles.colWidths.length) port.setColWidths(sheet, 1, styles.colWidths);
}

function hasStyle(s: Style): boolean {
  return s.bg !== undefined || s.fontColor !== undefined || s.bold !== undefined ||
    s.numberFormat !== undefined || s.border !== undefined;
}

// --- computeShard: чистый счётчик ------------------------------------------------------------

export interface ShardResult {
  shard: number;
  rounds: number;
  seconds: number;
  hash: string;
  rtp: number;
  profile: string;
  mode: string;
  seed: number;
  rows: Row[];
}

/**
 * Считает и ВОЗВРАЩАЕТ строки колонки. Порта не касается (см. шапку файла: параллельные
 * исполнения, пишущие один шит, теряют записи). Свой сид у каждой колонки: `seed + shard − 1`
 * → независимые последовательности.
 */
export function statsComputeShard(
  adapter: StatsAdapter, shard: number, params: RunParams & { rounds?: number } = {}
): ShardResult {
  const t0 = Date.now();
  const built = adapter.buildConfig(params.profile);
  const config = built.config;
  const mode = params.mode || 'base';
  const opts = adapter.modeOpts ? adapter.modeOpts(mode) : {};
  const defaults = adapter.defaults || {};
  const rounds = Math.max(1, Math.floor(Number(params.rounds)) || defaults.rounds || 100000);
  const base = Math.floor(Number(params.seed)) || defaults.seed || 0;
  const seed = base + shard - 1;
  const roundSeed = adapter.roundSeed || defaultRoundSeed;

  const st = adapter.newStats();
  for (let i = 0; i < rounds; i++) {
    const roundOpts: Record<string, unknown> = { ...opts, seed: roundSeed(seed, i) };
    adapter.accumulate(st, adapter.playRound(config, roundOpts), config);
  }
  const seconds = (Date.now() - t0) / 1000;
  const hash = statsConfigHash(adapter, config);
  const rows = adapter.manifest(st, config, {
    date: statsSerialDate(), profile: built.profileName, mode, seed, config_hash: hash, seconds
  });
  const by = rowsByLabel(rows);
  const wager = by[L_EWAGER], win = by[L_EWIN];
  return {
    shard, rounds, seconds, hash, profile: built.profileName, mode, seed,
    rtp: typeof wager === 'number' && wager ? (Number(win) / wager) * 100 : 0,
    rows
  };
}

function defaultRoundSeed(seed: number, i: number): number { return (seed ^ (i * 0x9e3779b1)) | 0; }

// --- writeRun: единственный писатель прогона -------------------------------------------------

/**
 * Кладёт досчитанные колонки одним исполнением (свежая ревизия документа). Частичный набор
 * колонок легитимен: агрегат честно взвешен по Rounds (§3.2). Лейблы вкладки сверяются с
 * манифестом результата — писать числа в чужую раскладку нельзя.
 */
export function statsWriteRun(
  port: SheetPort, adapter: StatsAdapter, results: ShardResult[], params: RunParams = {},
  opts: TableOptions = {}
): { columns: number } {
  if (!results || !results.length) throw new Error('statsWriteRun: нет ни одной досчитанной колонки');
  const layout = layoutOf(opts), sheets = sheetsOf(opts);
  const L = layout.stats;
  const first = (results[0] as ShardResult).rows;

  const labels = port.read(sheets.stats, L.firstRow, L.labelCol, first.length, 1);
  for (let i = 0; i < first.length; i++) {
    const got = str(((labels[i] || []) as Cell[])[0]);
    if (got !== (first[i] as Row).label) {
      throw new Error('stats: строка ' + (L.firstRow + i) + ' — лейбл «' + got + '» ≠ манифесту «' +
        (first[i] as Row).label + '». Прогоните заново (init пересоберёт вкладку).');
    }
  }

  const dialect = dialectOf(adapter, adapter.buildConfig(params.profile).config);
  const dateRow = statsManifestRow(first, L_DATE, layout);
  for (let k = 0; k < results.length; k++) {
    const res = results[k] as ShardResult;
    const col = L.firstShardCol + res.shard - 1;
    port.write(sheets.stats, L.firstRow, col, statsShardValues(res.rows));
    if (dateRow > 0 && dialect && dialect.date) {
      port.format(sheets.stats, dateRow, col, 1, 1, { numberFormat: dialect.date });
    }
  }
  port.flush();
  return { columns: results.length };
}

// --- Чтение агрегата и проверки --------------------------------------------------------------

/** Строки агрегата: лейбл + ВЫЧИСЛЕННОЕ значение агрегатной колонки. */
export function statsAggregateFromSheet(
  port: SheetPort, opts: TableOptions = {}
): Array<{ label: string; value: RowValue }> {
  const layout = layoutOf(opts), sheets = sheetsOf(opts);
  const L = layout.stats;
  port.flush(); // формулы агрегата обязаны быть пересчитаны
  const size = port.size(sheets.stats);
  if (size.rows < L.firstRow) {
    throw new Error('stats: вкладка пуста — сначала прогон (панель соберёт скелет)');
  }
  const n = size.rows - L.firstRow + 1;
  const labels = port.read(sheets.stats, L.firstRow, L.labelCol, n, 1);
  const values = port.read(sheets.stats, L.firstRow, L.aggCol, n, 1);
  const out: Array<{ label: string; value: RowValue }> = [];
  for (let i = 0; i < n; i++) {
    const label = str(((labels[i] || []) as Cell[])[0]);
    if (label === '') continue;
    out.push({ label, value: ((values[i] || []) as Cell[])[0] as RowValue });
  }
  return out;
}

export interface HomogeneityCheck { columns: number; hash: string; mode: string; profile: string }

/**
 * Однородность прогона (§5.5): все непустые колонки-шарды обязаны иметь один профиль, один режим
 * и один хэш конфига, и этот хэш обязан совпасть с текущим конфигом документа. Иначе агрегат
 * смешал бы разные игры — и промолчал.
 */
export function statsAssertHomogeneous(
  port: SheetPort, adapter: StatsAdapter, profileName: string, mode?: string, opts: TableOptions = {}
): HomogeneityCheck {
  const layout = layoutOf(opts), sheets = sheetsOf(opts);
  const L = layout.stats;
  const size = port.size(sheets.stats);
  if (size.cols < L.firstShardCol) throw new Error('stats: нет ни одной колонки-шарда');

  const n = size.rows - L.firstRow + 1;
  const labels = port.read(sheets.stats, L.firstRow, L.labelCol, n, 1);
  const grid = port.read(sheets.stats, L.firstRow, L.firstShardCol, n, size.cols - L.firstShardCol + 1);
  const rowOf: Record<string, number> = {};
  for (let i = 0; i < n; i++) rowOf[str(((labels[i] || []) as Cell[])[0])] = i;
  function need(label: string): number {
    const r = rowOf[label];
    if (r === undefined) throw new Error('stats: во вкладке нет строки «' + label + '» — манифест не тот');
    return r;
  }
  const cell = (r: number, c: number): Cell => ((grid[r] || []) as Cell[])[c];

  const seen: Record<string, number> = {};
  let filled = 0;
  const width = (grid[0] || []).length;
  for (let c = 0; c < width; c++) {
    if (!cell(need(L_ROUNDS), c)) continue;
    filled++;
    const key = [str(cell(need(L_PROFILE), c)), str(cell(need(L_MODE), c)),
      str(cell(need(L_CONFIG_HASH), c))].join(' | ');
    seen[key] = (seen[key] || 0) + 1;
  }
  if (filled === 0) throw new Error('stats: ни одна колонка-шард не заполнена');
  const keys: string[] = [];
  for (const k in seen) keys.push(k);
  if (keys.length > 1) {
    throw new Error('stats: колонки от разных прогонов — агрегат смешал бы разные игры:\n  ' +
      keys.join('\n  ') + '\nПрогоните заново (init пересоберёт вкладку).');
  }
  const parts = (keys[0] as string).split(' | ');
  if (parts[0] !== profileName || parts[1] !== (mode || 'base')) {
    throw new Error('stats: в колонках лежит прогон «' + parts[0] + ' × ' + parts[1] +
      '», а в панели выбрано «' + profileName + ' × ' + (mode || 'base') + '»');
  }
  const current = statsConfigHash(adapter, adapter.buildConfig(profileName).config);
  if (parts[2] !== current) {
    throw new Error('stats: колонки протухли — хэш конфига прогона ' + parts[2] +
      ' ≠ текущему ' + current + ' (конфиг правили после прогона). Прогоните заново.');
  }
  return { columns: filled, hash: parts[2] as string, mode: parts[1] as string, profile: parts[0] as string };
}

/**
 * Инвалидация по хэшу конфига (§1). Хэш считает движок — формула шита сама этого не может,
 * поэтому «текущий» хэш кладётся в агрегатную ячейку строки инвалидации, а формулы строки
 * сверяют с ним хэш каждой колонки. Протухшая колонка кричит «ПРОТУХЛА», а не молчит (§5.5).
 */
export function statsCheckStale(
  port: SheetPort, adapter: StatsAdapter, profileName?: string | null, opts: TableOptions = {}
): { hash: string; stale: number; columns: number; ready: boolean } {
  const layout = layoutOf(opts), sheets = sheetsOf(opts);
  const L = layout.stats;
  const size = port.size(sheets.stats);
  if (size.rows < L.firstRow) return { hash: '', stale: 0, columns: 0, ready: false };

  const current = statsConfigHash(adapter, adapter.buildConfig(profileName).config);
  port.write(sheets.stats, layout.staleRow, L.aggCol, [[current]]);
  port.flush();

  let stale = 0, columns = 0;
  if (size.cols >= L.firstShardCol) {
    const marks = (port.read(sheets.stats, layout.staleRow, L.firstShardCol, 1,
      size.cols - L.firstShardCol + 1)[0] || []) as Cell[];
    for (let i = 0; i < marks.length; i++) {
      const m = str(marks[i]);
      if (m === '') continue;
      columns++;
      if (m !== 'ok') stale++;
    }
  }
  return { hash: current, stale, columns, ready: true };
}

/** Сбросить вкладку stats целиком (витрина + сырьё). Init соберёт её заново. */
export function statsClearTab(port: SheetPort, opts: TableOptions = {}): { cleared: number } {
  const sheets = sheetsOf(opts);
  const size = port.size(sheets.stats);
  if (size.rows < 1 || size.cols < 1) return { cleared: 0 };
  port.clear(sheets.stats);
  port.flush();
  return { cleared: size.rows };
}

// --- commitSummary ---------------------------------------------------------------------------

export interface CommitResult { columns: number; rows: number; col: number; rtp: RowValue }

/**
 * Коммит агрегата в statSummary: оверврайт колонки по ключу профиль × режим, ЗНАЧЕНИЯМИ.
 * Промежуточные состояния (агрегат трёх колонок из восьми) легитимны: это честный агрегат того,
 * что уже досчитано (§3.2).
 */
export function statsCommitSummary(
  port: SheetPort, adapter: StatsAdapter, params: RunParams = {}, opts: TableOptions = {}
): CommitResult {
  const layout = layoutOf(opts), sheets = sheetsOf(opts);
  const profileName = String(params.profile);
  const mode = params.mode || 'base';
  const check = statsAssertHomogeneous(port, adapter, profileName, mode, opts);
  const rows = statsAggregateFromSheet(port, opts);

  port.ensureSheet(sheets.summary);
  const res = statsUpsertSummaryColumn(portGrid(port, sheets.summary), { profile: profileName, mode }, rows, layout);
  const updated = statsRectangular(res.grid);
  port.clear(sheets.summary);
  if (updated.length) port.write(sheets.summary, 1, 1, updated);

  const dialect = dialectOf(adapter, adapter.buildConfig(profileName).config);
  const dateRow = statsFindLabelRow(updated, layout.summary.labelCol, L_DATE);
  if (dateRow > 0 && dialect && dialect.date) {
    port.format(sheets.summary, dateRow, res.col, 1, 1, { numberFormat: dialect.date });
  }
  port.flush();

  const by: Record<string, RowValue> = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as { label: string; value: RowValue };
    by[r.label] = r.value;
  }
  return { columns: check.columns, rows: rows.length, col: res.col, rtp: by[L_RTP] as RowValue };
}

// --- writeActuals ----------------------------------------------------------------------------

export interface ActualsResult { written: number; profile: string; mode: string; hash: string; columns: number }

/**
 * Врайтбек actual_* в profiles ПОВЕРХ АГРЕГАТА — адресный, по имени строки. Отсутствие колонки
 * профиля или строки actual_* — исключение (§3.3): кнопка покраснеет, тихого скипа нет.
 * Грид целиком не пишем: в profiles живут формулы (converged и прочее).
 */
export function statsWriteActuals(
  port: SheetPort, adapter: StatsAdapter, params: RunParams = {}, opts: TableOptions = {}
): ActualsResult {
  if (!adapter.actuals) throw new Error('table: адаптер не объявил actuals() — врайтбеку нечего писать');
  const layout = layoutOf(opts), sheets = sheetsOf(opts);
  const profileName = String(params.profile);
  const check = statsAssertHomogeneous(port, adapter, profileName, params.mode, opts);
  const rows = statsAggregateFromSheet(port, opts);
  const by: Record<string, RowValue> = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as { label: string; value: RowValue };
    by[r.label] = r.value;
  }
  const values = adapter.actuals(by, {
    mode: check.mode, hash: check.hash, date: statsSerialDate(), profile: profileName
  });

  const plan = statsPlanProfileActuals(portGrid(port, sheets.profiles), profileName, values, layout);
  const dialect = dialectOf(adapter, adapter.buildConfig(profileName).config);
  const isDate = opts.isDateKey || defaultIsDateKey;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i] as { key: string; row: number; col: number; value: Cell };
    port.write(sheets.profiles, p.row, p.col, [[p.value]]);
    if (isDate(p.key) && dialect && dialect.date) {
      port.format(sheets.profiles, p.row, p.col, 1, 1, { numberFormat: dialect.date });
    }
  }
  port.flush();
  return { written: plan.length, profile: profileName, mode: check.mode, hash: check.hash, columns: check.columns };
}

function defaultIsDateKey(key: string): boolean { return key.indexOf('actual_date') === 0; }
