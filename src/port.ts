// SheetPort — узкая транспортная абстракция таблицы (§8 спеки).
//
// Вся grid/шардинг-логика (table.ts) пишется ПРОТИВ этого интерфейса и потому работает
// одинаково в трёх мирах: GAS (GasPort, SpreadsheetApp), node (ApiPort, Sheets API v4) и
// в тестах (MemPort, массивы в памяти).
//
// Интерфейс СИНХРОННЫЙ и таким остаётся: в Apps Script другого не бывает (UrlFetchApp,
// SpreadsheetApp — блокирующие, промис некому резолвить), а table-слой один на все порты.
// Сетевой ApiPort живёт с этим так: данные читаются в кэш заранее (`await load([...])`),
// записи копятся в буфере, `flush()` закрывает батч, `await commit()` отправляет. Отсюда же
// правило `size/read` — «использованный прямоугольник», а не бесконечная сетка: у всех трёх
// реализаций есть дешёвый ответ на этот вопрос (getLastRow, длина массива, ответ API).

import type { Cell, Grid } from './types.ts';

/**
 * Минимальный набор оформления. Больше полей НЕ добавлять без второго реального потребителя:
 * узкий стиль — единственное, что три порта могут реализовать честно и одинаково.
 * `bg`/`fontColor` — '#rrggbb'; `numberFormat` — паттерн Sheets; `border` — рамка по периметру
 * ('box') или по всем ячейкам ('all').
 */
export interface Style {
  bg?: string;
  fontColor?: string;
  bold?: boolean;
  numberFormat?: string;
  border?: 'box' | 'all';
}

/** Использованный прямоугольник вкладки (1-based размеры, 0 — вкладка пуста). */
export interface SheetSize { rows: number; cols: number }

/** Транспорт таблицы. Все координаты 1-based, как в Sheets. */
export interface SheetPort {
  /** Вкладка обязана существовать после вызова (создаётся, если её нет). */
  ensureSheet(name: string): void;
  /** Использованный прямоугольник (двойник getLastRow/getLastColumn). */
  size(name: string): SheetSize;
  /** Значения прямоугольника. Формулы читаются ВЫЧИСЛЕННЫМИ (как getValues / UNFORMATTED_VALUE). */
  read(name: string, row: number, col: number, numRows: number, numCols: number): Grid;
  /** Запись значений; строка, начинающаяся с '=', — формула (семантика USER_ENTERED). */
  write(name: string, row: number, col: number, values: Grid): void;
  /** Оформление прямоугольника. Пустой стиль — no-op. */
  format(name: string, row: number, col: number, numRows: number, numCols: number, style: Style): void;
  /** Ширины колонок в пикселях, начиная с colStart. */
  setColWidths(name: string, colStart: number, widths: number[]): void;
  /** Очистить содержимое вкладки (оформление не трогаем — его перепишет init). */
  clear(name: string): void;
  /** Граница батча: до неё записи можно копить, после — они обязаны быть видны читателю порта. */
  flush(): void;
}

/** Весь использованный прямоугольник вкладки одним чтением (двойник getDataRange().getValues()). */
export function portGrid(port: SheetPort, name: string): Grid {
  const s = port.size(name);
  if (s.rows < 1 || s.cols < 1) return [];
  return port.read(name, 1, 1, s.rows, s.cols);
}

/** Записать грид, начиная с (row, col), одним вызовом. Пустой грид — no-op. */
export function portWriteGrid(port: SheetPort, name: string, row: number, col: number, grid: Grid): void {
  if (!grid.length) return;
  port.write(name, row, col, grid);
}

// --- MemPort ---------------------------------------------------------------------------------

/** Снимок вкладки MemPort: значения + журнал оформления + ширины колонок. */
export interface MemSnapshot {
  values: Grid;
  /** Ключ — 'row:col' (1-based), значение — накопленный стиль ячейки. */
  styles: Record<string, Style>;
  /** Ключ — номер колонки (1-based). */
  widths: Record<string, number>;
}

export interface MemPortOptions {
  /**
   * Вычислитель формул (тестовый шов). Порт хранит формулы строками; реальные Sheets отдают на
   * чтение ЗНАЧЕНИЕ. Передав сюда вычислитель, тест получает то же поведение, что у GAS и API:
   * `new MemPort({}, { evaluate: sheetEvaluator })`, где evaluate(grid) → (row, col) => value.
   * Без него формулы читаются как есть — этого достаточно для проверки самих формул.
   */
  evaluate?: (grid: Grid) => (row: number, col: number) => Cell;
}

interface MemSheet { values: Grid; styles: Record<string, Style>; widths: Record<string, number> }

/** In-memory реализация: тестируемость всей grid-логики без живого GAS (сценарий №1 спеки). */
export class MemPort implements SheetPort {
  private sheets: Record<string, MemSheet> = {};
  private evaluate: MemPortOptions['evaluate'];
  /** Счётчик flush() — тест может проверить, что записи батчатся, а не сыпятся по одной. */
  flushes = 0;

  constructor(initial: Record<string, Grid> = {}, options: MemPortOptions = {}) {
    this.evaluate = options.evaluate;
    for (const name in initial) {
      this.sheets[name] = { values: cloneGrid(initial[name] as Grid), styles: {}, widths: {} };
    }
  }

  /** Вкладки порта (для тестов и отладки). */
  names(): string[] { return Object.keys(this.sheets); }

  ensureSheet(name: string): void {
    if (!this.sheets[name]) this.sheets[name] = { values: [], styles: {}, widths: {} };
  }

  size(name: string): SheetSize {
    const sh = this.need(name);
    let rows = 0, cols = 0;
    for (let r = 0; r < sh.values.length; r++) {
      const line = sh.values[r] as Cell[] | undefined;
      if (!line) continue;
      let last = 0;
      for (let c = 0; c < line.length; c++) if (line[c] !== undefined && line[c] !== '') last = c + 1;
      if (last > 0) { rows = r + 1; if (last > cols) cols = last; }
    }
    return { rows, cols };
  }

  read(name: string, row: number, col: number, numRows: number, numCols: number): Grid {
    const sh = this.need(name);
    const value = this.evaluate ? this.evaluate(sh.values) : rawReader(sh.values);
    const out: Grid = [];
    for (let r = 0; r < numRows; r++) {
      const line: Cell[] = [];
      for (let c = 0; c < numCols; c++) line.push(value(row + r, col + c));
      out.push(line);
    }
    return out;
  }

  write(name: string, row: number, col: number, values: Grid): void {
    const sh = this.need(name);
    for (let r = 0; r < values.length; r++) {
      const line = (values[r] || []) as Cell[];
      for (let c = 0; c < line.length; c++) setCell(sh.values, row + r, col + c, line[c]);
    }
  }

  format(name: string, row: number, col: number, numRows: number, numCols: number, style: Style): void {
    const sh = this.need(name);
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < numCols; c++) {
        const key = (row + r) + ':' + (col + c);
        sh.styles[key] = { ...(sh.styles[key] || {}), ...style };
      }
    }
  }

  setColWidths(name: string, colStart: number, widths: number[]): void {
    const sh = this.need(name);
    for (let i = 0; i < widths.length; i++) sh.widths[String(colStart + i)] = widths[i] as number;
  }

  clear(name: string): void {
    const sh = this.need(name);
    sh.values = [];
  }

  flush(): void { this.flushes++; }

  /** Снимок вкладки: значения (как записаны, формулы строками), стили, ширины. */
  snapshot(name: string): MemSnapshot {
    const sh = this.need(name);
    return { values: cloneGrid(sh.values), styles: { ...sh.styles }, widths: { ...sh.widths } };
  }

  /** Стиль ячейки (или пустой объект). */
  styleAt(name: string, row: number, col: number): Style {
    return { ...(this.need(name).styles[row + ':' + col] || {}) };
  }

  private need(name: string): MemSheet {
    const sh = this.sheets[name];
    if (!sh) throw new Error('MemPort: нет вкладки «' + name + '» (ensureSheet её создаёт)');
    return sh;
  }
}

function rawReader(values: Grid): (row: number, col: number) => Cell {
  return function value(row: number, col: number): Cell {
    const line = values[row - 1] as Cell[] | undefined;
    const v = line ? line[col - 1] : undefined;
    return v === undefined || v === null ? '' : v;
  };
}

function setCell(values: Grid, row: number, col: number, v: Cell): void {
  while (values.length < row) values.push([]);
  const line = values[row - 1] as Cell[];
  while (line.length < col) line.push('');
  line[col - 1] = v === undefined || v === null ? '' : v;
}

function cloneGrid(grid: Grid): Grid {
  const out: Grid = [];
  for (let r = 0; r < grid.length; r++) out.push(((grid[r] || []) as Cell[]).slice());
  return out;
}
