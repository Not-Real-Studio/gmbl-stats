// @gmbl/gm-stats — ядро статистики слотов.
//
// Что здесь: словари распределений (buckets), правила агрегации (aggregate), авто-слияние
// шардов (merge), DSL манифеста и секции-генераторы (manifest), хелперы аккумуляции (accum),
// хэш конфига (hash), раскладка вкладки и агрегатные формулы (grid), оркестрация прогона
// панелью (panel).
//
// Что остаётся игре: newStats/accumulate, состав манифеста (секции + свои строки), снапшот
// конфига для хэша, лейблы витрины. Правило дома: механизм переезжает в ядро после ВТОРОГО
// использования, не раньше.

export type {
  Agg, RowValue, Row, Bucket, CountEntry, CountMap, CoinMap, BaseStats, Stats, Provenance,
  Dialect, Cell, Grid, PayableSymbol, ComboConfig
} from './types.ts';

export {
  STAT_LADDER, STAT_FINE_STEP, STAT_FINE_MAX, DEFAULT_BUCKETS, makeBuckets, makeBucketsFromSpec,
  parseLadder, parseFine, statBuckets, statBucketLabel, statFineLabels, statFineLabel
} from './buckets.ts';
export type { Buckets } from './buckets.ts';

export {
  L_ROUNDS, L_SPINS, L_WAGERED, L_TIME, L_SPEED, L_NOISE, L_EWAGER, L_EWIN, L_MEANX, L_STD,
  L_RTP, L_WIN_COUNT, L_HIT, L_MAXWIN_COINS, L_MAXWIN_X, L_WINCAP_HITS, L_WINCAP_ONE_IN,
  L_WINCAP_ONE_IN_SPIN, L_WINCAP_PCT, L_DATE, L_PROFILE, L_MODE, L_SEED, L_CONFIG_HASH,
  STAT_VALUE_AGGS, isValueAgg, aggregateRows, rowsByLabel
} from './aggregate.ts';

export { mergeStats } from './merge.ts';
export type { MergeRule, MergeOverrides } from './merge.ts';

export { bumpN, bumpWin, addCoins, entry, EMPTY_ENTRY, baseStats, accumulateBase } from './accum.ts';

export { configHash } from './hash.ts';

export {
  manifestBuilder, moments, provenanceSection, rtpSection, histSection, fineSection,
  comboSection, payableSymbols
} from './manifest.ts';
export type {
  ManifestBuilder, ManifestOptions, Moments, RtpSource, RtpOptions, HistSet, HistOptions, ComboSet
} from './manifest.ts';

export {
  STAT_LAYOUT, makeLayout, statsStr, statsIsEmpty, statsColName, statsLocalizeFormula,
  statsAggregateFormulas, statsStaleFormulas, statsSkeleton, statsShardValues, statsVitrineRef,
  dashboardContent, distributionContent, comboContent, statsUpsertSummaryColumn,
  statsFindLabelRow, statsPlanProfileActuals, statsWriteProfileActuals, statsTrimTrailing,
  statsRectangular
} from './grid.ts';
export type { Layout, LayoutOverrides, Skeleton, DashboardLabel, DistSet, ActualWrite } from './grid.ts';

export { MemPort, portGrid, portWriteGrid } from './port.ts';
export type { SheetPort, SheetSize, Style, MemPortOptions, MemSnapshot } from './port.ts';

export { GasPort } from './gas-port.ts';

export {
  DEFAULT_SHEETS, DEFAULT_STYLES, statsSerialDate, statsConfigHash, statsManifestRow,
  statsReadParams, statsPrepareRun, statsComputeShard, statsWriteRun, statsAggregateFromSheet,
  statsAssertHomogeneous, statsCheckStale, statsClearTab, statsCommitSummary, statsWriteActuals
} from './table.ts';
export type {
  StatsAdapter, BuiltConfig, RoundResult, ActualsContext, SheetNames, TableStyles, TableOptions,
  RunParams, SavedParams, InitResult, ShardResult, HomogeneityCheck, CommitResult, ActualsResult
} from './table.ts';

export { statsPanelHtml, statsPanelLimits, statsPanelInfo } from './panel.ts';
export type { PanelSpec, PanelLimits, PanelInfo } from './panel.ts';
