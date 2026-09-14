// Типы ядра статистики. Единственный источник формы строки манифеста, аккумулятора и грида.

/** Правило агрегации строки манифеста (реализовано дважды: кодом — aggregate.ts, формулами — grid.ts). */
export type Agg =
  | 'section' | 'text' | 'date'
  | 'sum' | 'max' | 'wavg' | 'std' | 'speed' | 'noise'
  | 'rtp' | 'share' | 'pct' | 'ratio' | 'one_in';

/** Значение ячейки колонки прогона: число, provenance-строка/дата или пусто. */
export type RowValue = number | string | null;

/** Строка манифеста. `of`/`per` — ссылки на другие строки ПО ЛЕЙБЛУ (не по позиции). */
export interface Row {
  label: string;
  agg: Agg;
  of: string | null;
  per: string | null;
  value: RowValue;
}

/** Бакет гистограммы: lo включительно, hi исключительно (в кратностях ставки). */
export interface Bucket {
  label: string;
  lo: number;
  hi: number;
  /** Точечный бакет (`lo === hi`): попадание ровно в кап, с допуском. */
  exact?: boolean;
}

/** Ячейка распределения: сколько раз попали, сколько монет принесли, сколько из них выигрышных. */
export interface CountEntry {
  n: number;
  coins: number;
  wins: number;
}

/** Распределение: лейбл бакета → счётчики. */
export type CountMap = Record<string, Partial<CountEntry>>;

/** Плоская карта монет/счётчиков: ключ → число. */
export type CoinMap = Record<string, number>;

/** Стандартное ядро аккумулятора. Игра расширяет спредом: `{...baseStats(), sumFg: 0}`. */
export interface BaseStats {
  rounds: number;
  spins: number;
  wagered: number;
  sumWin: number;
  sumXSq: number;
  winRounds: number;
  maxWin: number;
  bkTotal: CountMap;
  fineTotal: CountMap;
}

/** Аккумулятор игры: ядро + произвольные игровые поля. */
export type Stats = BaseStats & Record<string, unknown>;

/** Штамп прогона (§1: колонка прогона анонимной быть не может). */
export interface Provenance {
  date?: number | string | null;
  profile?: string | null;
  mode?: string | null;
  seed?: number | string | null;
  config_hash?: string | null;
  seconds?: number;
}

/** Диалект документа: разделитель аргументов формул и числовой формат даты. */
export interface Dialect {
  formulaArg?: string;
  date?: string;
}

/** Ячейка грида таблицы (значение или формула — строка с `=`). */
export type Cell = string | number | boolean | null | undefined;
export type Grid = Cell[][];

/** Платящий символ: id (ключ paytable) + человеческое имя + эффективные длины. */
export interface PayableSymbol {
  id: string | number;
  name: string;
  lens: number[];
}

/** Срез конфига, нужный combo-секции и combo-витрине. */
export interface ComboConfig {
  symbols: Array<{ id: string | number; name: string }>;
  paytable: Record<string, Record<string, number> | undefined>;
}
