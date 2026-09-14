// GasPort — SheetPort поверх SpreadsheetApp. Едет в GAS-бандл; в node существует, но при вызове
// требует живой SpreadsheetApp (тесты подсовывают стаб — так же, как это делает GAS-песочница
// проекта-игры).
//
// Ровно та работа с шитом, которую раньше руками делал stats-tab.js каждого слота: рост листа под
// скелет, запись прямоугольников, числовой формат даты, ширины колонок. Логики статистики здесь
// нет ни строки — она в table.ts и одинакова для всех трёх портов.

import type { Cell, Grid } from './types.ts';
import type { SheetPort, SheetSize, Style } from './port.ts';

// --- Минимальная типизация SpreadsheetApp (полного @types/google-apps-script здесь не нужно) --

interface GasRange {
  getValues(): Cell[][];
  setValues(values: Cell[][]): unknown;
  setValue(value: Cell): unknown;
  clearContent(): unknown;
  setNumberFormat(format: string): unknown;
  setBackground?(color: string): unknown;
  setFontColor?(color: string): unknown;
  setFontWeight?(weight: string): unknown;
  setBorder?(top: boolean | null, left: boolean | null, bottom: boolean | null, right: boolean | null,
    vertical: boolean | null, horizontal: boolean | null): unknown;
}

interface GasSheet {
  getName(): string;
  getLastRow(): number;
  getLastColumn(): number;
  getMaxRows(): number;
  getMaxColumns(): number;
  insertRowsAfter(after: number, count: number): unknown;
  insertColumnsAfter(after: number, count: number): unknown;
  getRange(row: number, col: number, numRows?: number, numCols?: number): GasRange;
  setColumnWidth?(col: number, width: number): unknown;
}

interface GasBook {
  getSheetByName(name: string): GasSheet | null;
  insertSheet?(name: string): GasSheet;
}

interface GasApp {
  getActiveSpreadsheet(): GasBook;
  flush(): void;
}

declare const SpreadsheetApp: GasApp;

/** Порт активной книги (или переданной — например, при работе с чужим документом). */
export class GasPort implements SheetPort {
  private book: GasBook;
  private cache: Record<string, GasSheet> = {};

  constructor(book?: GasBook) {
    this.book = book || SpreadsheetApp.getActiveSpreadsheet();
  }

  ensureSheet(name: string): void {
    if (this.cache[name]) return;
    let sh = this.book.getSheetByName(name);
    if (!sh) {
      if (!this.book.insertSheet) throw new Error('GasPort: в книге нет вкладки «' + name + '»');
      sh = this.book.insertSheet(name);
    }
    this.cache[name] = sh;
  }

  size(name: string): SheetSize {
    const sh = this.sheet(name);
    return { rows: sh.getLastRow(), cols: sh.getLastColumn() };
  }

  read(name: string, row: number, col: number, numRows: number, numCols: number): Grid {
    if (numRows < 1 || numCols < 1) return [];
    return this.sheet(name).getRange(row, col, numRows, numCols).getValues();
  }

  write(name: string, row: number, col: number, values: Grid): void {
    if (!values.length) return;
    const sh = this.sheet(name);
    let width = 0;
    for (let r = 0; r < values.length; r++) {
      const line = (values[r] || []) as Cell[];
      if (line.length > width) width = line.length;
    }
    if (width < 1) return;
    // setValues требует прямоугольник без дырок — разреженный грид дополняем пустыми ячейками
    const rect: Cell[][] = [];
    for (let r = 0; r < values.length; r++) {
      const line = (values[r] || []) as Cell[];
      const out: Cell[] = [];
      for (let c = 0; c < width; c++) out.push(line[c] === undefined || line[c] === null ? '' : line[c]);
      rect.push(out);
    }
    this.grow(sh, row + rect.length - 1, col + width - 1);
    sh.getRange(row, col, rect.length, width).setValues(rect);
  }

  format(name: string, row: number, col: number, numRows: number, numCols: number, style: Style): void {
    if (numRows < 1 || numCols < 1) return;
    const sh = this.sheet(name);
    this.grow(sh, row + numRows - 1, col + numCols - 1);
    const range = sh.getRange(row, col, numRows, numCols);
    if (style.bg && range.setBackground) range.setBackground(style.bg);
    if (style.fontColor && range.setFontColor) range.setFontColor(style.fontColor);
    if (style.bold !== undefined && range.setFontWeight) range.setFontWeight(style.bold ? 'bold' : 'normal');
    if (style.numberFormat) range.setNumberFormat(style.numberFormat);
    if (style.border && range.setBorder) {
      const inner = style.border === 'all' ? true : null;
      range.setBorder(true, true, true, true, inner, inner);
    }
  }

  setColWidths(name: string, colStart: number, widths: number[]): void {
    const sh = this.sheet(name);
    if (!sh.setColumnWidth) return;
    for (let i = 0; i < widths.length; i++) {
      const w = widths[i];
      if (typeof w === 'number' && w > 0) sh.setColumnWidth(colStart + i, w);
    }
  }

  clear(name: string): void {
    const sh = this.sheet(name);
    const rows = sh.getLastRow(), cols = sh.getLastColumn();
    if (rows < 1 || cols < 1) return;
    sh.getRange(1, 1, rows, cols).clearContent();
  }

  flush(): void { SpreadsheetApp.flush(); }

  /** Лист по имени (кэш: getSheetByName — не бесплатный вызов). */
  sheet(name: string): GasSheet {
    if (!this.cache[name]) this.ensureSheet(name);
    return this.cache[name] as GasSheet;
  }

  // Место под скелет: манифест бывает под тысячу строк, дефолт листа — 1000×26.
  private grow(sh: GasSheet, needRows: number, needCols: number): void {
    const maxR = sh.getMaxRows(), maxC = sh.getMaxColumns();
    if (maxR < needRows) sh.insertRowsAfter(maxR, needRows - maxR);
    if (maxC < needCols) sh.insertColumnsAfter(maxC, needCols - maxC);
  }
}
