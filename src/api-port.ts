// ApiPort — SheetPort поверх Google Sheets API v4 (node). Прямой fetch, ноль зависимостей:
// googleapis сюда не поедет ни при каких обстоятельствах (правило дома).
//
// ВАЖНО ПРО ГРАНИЦЫ (спека §8): GAS-ферма (50 шардов × 20M ≈ 1B раундов за ~2 минуты) —
// ОСНОВНОЙ вычислитель массовых прогонов, никакая локальная железка это не бьёт. ApiPort —
// дополнение: чтение результатов из node, автоматизация, мелкие прикидки (1–5M), тесты.
// Со smir (TOON-зеркало) он тоже не конкурирует: smir — версионируемая структурная синхронизация
// групп вкладок с git-историей, ApiPort — живой точечный доступ в моменте.
//
// Этот файл НЕ входит в GAS-бандл (его нет в index.ts): здесь сеть и node:fs. Импорт —
// `@gmbl/gm-stats/api`.
//
// СИНХРОННЫЙ порт поверх асинхронной сети — единственный честный способ сделать так, чтобы
// table-слой был один на GAS и на node:
//   await port.load(['stats'])   // читаем вкладки в кэш (значения — вычисленные)
//   statsPrepareRun(port, adapter, …)   // синхронный код пишет В БУФЕР
//   await port.commit()          // буфер уезжает батчами (квота Sheets ~60 запросов/мин)
// flush() внутри table-слоя закрывает батч (границу), но сам сеть не трогает.

import { existsSync, readFileSync } from 'node:fs';
import type { Cell, Grid } from './types.ts';
import type { SheetPort, SheetSize, Style } from './port.ts';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_ENV_PATH = 'S:\\mcp\\laptop-v2\\.env';

// --- Auth (тот же механизм, что у laptop:gsheets / sheet-mirror) ------------------------------

export interface GoogleCredentials { clientId: string; clientSecret: string; refreshToken: string }

/**
 * Креды: сначала process.env, затем .env-файл (по умолчанию тот же, что у laptop:gsheets;
 * путь переопределяется параметром или GM_STATS_ENV / SHEET_MIRROR_ENV).
 */
export function loadGoogleCredentials(envPath?: string): GoogleCredentials {
  const path = envPath || process.env['GM_STATS_ENV'] || process.env['SHEET_MIRROR_ENV'] || DEFAULT_ENV_PATH;
  const env: Record<string, string> = {};
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^([^=#]+)=(.*)$/);
      if (m && m[1] !== undefined && m[2] !== undefined) env[m[1].trim()] = m[2].trim();
    }
  }
  const pick = (k: string): string => process.env[k] ?? env[k] ?? '';
  const creds: GoogleCredentials = {
    clientId: pick('GOOGLE_CLIENT_ID'),
    clientSecret: pick('GOOGLE_CLIENT_SECRET'),
    refreshToken: pick('GOOGLE_REFRESH_TOKEN')
  };
  if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
    throw new Error('ApiPort: нет Google OAuth кредов (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / ' +
      'GOOGLE_REFRESH_TOKEN) ни в окружении, ни в ' + path);
  }
  return creds;
}

/** Минимальная форма fetch, которая нужна порту (и которую легко подменить в тестах). */
export type FetchLike = (url: string, init?: {
  method?: string; headers?: Record<string, string>; body?: string;
}) => Promise<{ status: number; json(): Promise<unknown> }>;

function globalFetch(): FetchLike {
  const f = (globalThis as unknown as { fetch?: FetchLike }).fetch;
  if (!f) throw new Error('ApiPort: в этом рантайме нет fetch (нужен node 18+ или свой fetchImpl)');
  return f;
}

/** Обменивает refresh token на access token. */
export async function getAccessToken(creds: GoogleCredentials, fetchImpl?: FetchLike): Promise<string> {
  const doFetch = fetchImpl || globalFetch();
  const body = 'client_id=' + encodeURIComponent(creds.clientId) +
    '&client_secret=' + encodeURIComponent(creds.clientSecret) +
    '&refresh_token=' + encodeURIComponent(creds.refreshToken) +
    '&grant_type=refresh_token';
  const r = await doFetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const j = (await r.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!j.access_token) throw new Error('ApiPort OAuth: ' + (j.error_description || j.error || 'нет access_token'));
  return j.access_token;
}

// --- Опции и внутренние типы ------------------------------------------------------------------

export interface ApiPortOptions {
  credentials?: GoogleCredentials;
  /** Готовый access token (тесты, переиспользование между портами). */
  token?: string;
  /** Путь к .env с кредами (дефолт — как у laptop:gsheets). */
  envPath?: string;
  /** Формулы обязаны оставаться формулами → USER_ENTERED (дефолт). */
  valueInputOption?: 'USER_ENTERED' | 'RAW';
  fetchImpl?: FetchLike;
  /** Паузы бэкоффа на 429/503, мс. */
  retryDelays?: number[];
  /** Лог отправленных запросов (по умолчанию молчит). */
  onRequest?: (info: { method: string; path: string; attempt: number }) => void;
}

type OpKind = 'values' | 'clear' | 'request';
interface Op { kind: OpKind; sheet: string; range?: string; values?: Cell[][]; request?: Record<string, unknown> }

interface SheetMeta { sheetId: number; title: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Имя колонки по 1-based номеру (дубль statsColName — port не должен зависеть от grid). */
function colName(n: number): string {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}
function quoteSheet(name: string): string { return "'" + name.split("'").join("''") + "'"; }
function a1(name: string, row: number, col: number, numRows: number, numCols: number): string {
  return quoteSheet(name) + '!' + colName(col) + row + ':' + colName(col + numCols - 1) + (row + numRows - 1);
}
/**
 * Тип числового формата по паттерну: у GAS setNumberFormat типа нет вовсе, у API он обязателен.
 * Паттерн с d/m/y/h/s — дата-время, с 0/# — число, иначе текст.
 */
function numberFormatType(pattern: string): string {
  if (/[dmyhs]/i.test(pattern) && !/[0#]/.test(pattern)) return /[hs]/i.test(pattern) ? 'DATE_TIME' : 'DATE';
  if (/[0#]/.test(pattern)) return /[dmy]/i.test(pattern) ? 'DATE_TIME' : 'NUMBER';
  return 'TEXT';
}

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  const h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return {
    red: parseInt(full.slice(0, 2), 16) / 255,
    green: parseInt(full.slice(2, 4), 16) / 255,
    blue: parseInt(full.slice(4, 6), 16) / 255
  };
}

// --- ApiPort -----------------------------------------------------------------------------------

export class ApiPort implements SheetPort {
  readonly spreadsheetId: string;
  private opts: ApiPortOptions;
  private doFetch: FetchLike;
  private tokenValue: string | null;
  private creds: GoogleCredentials | null;
  private meta: Record<string, SheetMeta> = {};
  private metaLoaded = false;
  private cache: Record<string, Grid> = {};
  private ops: Op[] = [];
  /** Счётчик закрытых батчей — диагностика для тестов и логов. */
  batches = 0;

  constructor(spreadsheetId: string, options: ApiPortOptions = {}) {
    this.spreadsheetId = spreadsheetId;
    this.opts = options;
    this.doFetch = options.fetchImpl || globalFetch();
    this.tokenValue = options.token || null;
    this.creds = options.credentials || null;
  }

  // --- сеть ---

  private async token(): Promise<string> {
    if (this.tokenValue) return this.tokenValue;
    if (!this.creds) this.creds = loadGoogleCredentials(this.opts.envPath);
    this.tokenValue = await getAccessToken(this.creds, this.doFetch);
    return this.tokenValue;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const t = await this.token();
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    // Квота Sheets — per-minute; на 429/503 ждём и повторяем, остальное — громкая ошибка.
    const delays = this.opts.retryDelays || [4000, 12000, 30000, 60000];
    for (let attempt = 0; ; attempt++) {
      if (this.opts.onRequest) this.opts.onRequest({ method, path: path.split('?')[0] as string, attempt });
      const r = await this.doFetch(API + path, init);
      const j = (await r.json()) as { error?: { message?: string; code?: number } } & T;
      const err = j && j.error;
      if (!err) return j;
      const retriable = r.status === 429 || r.status === 503;
      if (retriable && attempt < delays.length) { await sleep(delays[attempt] as number); continue; }
      throw new Error('Sheets API (' + method + ' ' + (path.split('?')[0] as string) + '): ' +
        (err.message || 'unknown'));
    }
  }

  /** Свойства вкладок документа (sheetId нужен структурным запросам). */
  async loadMeta(): Promise<Record<string, SheetMeta>> {
    const j = await this.request<{ sheets?: Array<{ properties: SheetMeta }> }>(
      'GET', '/' + this.spreadsheetId + '?fields=sheets.properties(sheetId,title)');
    this.meta = {};
    for (const s of j.sheets || []) this.meta[s.properties.title] = s.properties;
    this.metaLoaded = true;
    return this.meta;
  }

  /**
   * Читает вкладки в кэш: значения ВЫЧИСЛЕННЫЕ (UNFORMATTED_VALUE) — то же, что видит getValues
   * в GAS. Без загрузки синхронный read() по вкладке — громкая ошибка (тихий пустой грид молча
   * превратил бы «не загрузили» в «данных нет»).
   */
  async load(names: string[]): Promise<void> {
    if (!this.metaLoaded) await this.loadMeta();
    const wanted = names.filter((n) => this.meta[n]);
    const missing = names.filter((n) => !this.meta[n]);
    for (const n of missing) this.cache[n] = [];
    if (!wanted.length) return;
    const qs = wanted.map((n) => 'ranges=' + encodeURIComponent(quoteSheet(n))).join('&');
    const j = await this.request<{ valueRanges?: Array<{ values?: Cell[][] }> }>(
      'GET', '/' + this.spreadsheetId + '/values:batchGet?' + qs +
      '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER');
    const ranges = j.valueRanges || [];
    for (let i = 0; i < wanted.length; i++) {
      this.cache[wanted[i] as string] = (ranges[i] && ranges[i]?.values) || [];
    }
  }

  /** Перечитать уже загруженные вкладки (после commit формулы отдают числа только так). */
  async reload(names?: string[]): Promise<void> {
    await this.load(names || Object.keys(this.cache));
  }

  /**
   * Отправляет накопленный буфер. Порядок операций сохраняется; подряд идущие однотипные
   * склеиваются в один запрос (квота!). Возвращает, сколько запросов ушло.
   */
  async commit(): Promise<{ requests: number; ops: number }> {
    const ops = this.ops;
    this.ops = [];
    if (!ops.length) return { requests: 0, ops: 0 };
    if (!this.metaLoaded) await this.loadMeta();

    let requests = 0;
    let i = 0;
    while (i < ops.length) {
      const kind = (ops[i] as Op).kind;
      const run: Op[] = [];
      while (i < ops.length && (ops[i] as Op).kind === kind) { run.push(ops[i] as Op); i++; }
      if (kind === 'values') {
        await this.request('POST', '/' + this.spreadsheetId + '/values:batchUpdate', {
          valueInputOption: this.opts.valueInputOption || 'USER_ENTERED',
          data: run.map((op) => ({ range: op.range, values: op.values }))
        });
      } else if (kind === 'clear') {
        await this.request('POST', '/' + this.spreadsheetId + '/values:batchClear', {
          ranges: run.map((op) => op.range)
        });
      } else {
        await this.request('POST', '/' + this.spreadsheetId + ':batchUpdate', {
          requests: run.map((op) => op.request)
        });
        // addSheet мог создать вкладку — метаданные протухли
        if (run.some((op) => op.request && op.request['addSheet'])) await this.loadMeta();
      }
      requests++;
    }
    return { requests, ops: ops.length };
  }

  /** Сколько операций ждёт отправки. */
  pending(): number { return this.ops.length; }

  // --- SheetPort (синхронная часть) ---

  ensureSheet(name: string): void {
    if (this.cache[name] === undefined) this.cache[name] = [];
    if (this.metaLoaded && !this.meta[name] && !this.ops.some((o) => o.kind === 'request' && o.sheet === name)) {
      this.ops.push({ kind: 'request', sheet: name, request: { addSheet: { properties: { title: name } } } });
    }
  }

  size(name: string): SheetSize {
    const grid = this.grid(name);
    let rows = 0, cols = 0;
    for (let r = 0; r < grid.length; r++) {
      const line = (grid[r] || []) as Cell[];
      let last = 0;
      for (let c = 0; c < line.length; c++) if (line[c] !== undefined && line[c] !== '') last = c + 1;
      if (last > 0) { rows = r + 1; if (last > cols) cols = last; }
    }
    return { rows, cols };
  }

  read(name: string, row: number, col: number, numRows: number, numCols: number): Grid {
    const grid = this.grid(name);
    const out: Grid = [];
    for (let r = 0; r < numRows; r++) {
      const line = (grid[row - 1 + r] || []) as Cell[];
      const dst: Cell[] = [];
      for (let c = 0; c < numCols; c++) {
        const v = line[col - 1 + c];
        dst.push(v === undefined || v === null ? '' : v);
      }
      out.push(dst);
    }
    return out;
  }

  write(name: string, row: number, col: number, values: Grid): void {
    if (!values.length) return;
    let width = 0;
    for (let r = 0; r < values.length; r++) {
      const line = (values[r] || []) as Cell[];
      if (line.length > width) width = line.length;
    }
    if (width < 1) return;
    const rect: Cell[][] = [];
    for (let r = 0; r < values.length; r++) {
      const line = (values[r] || []) as Cell[];
      const dst: Cell[] = [];
      for (let c = 0; c < width; c++) dst.push(line[c] === undefined || line[c] === null ? '' : line[c]);
      rect.push(dst);
    }
    this.applyToCache(name, row, col, rect);
    this.ops.push({ kind: 'values', sheet: name, range: a1(name, row, col, rect.length, width), values: rect });
  }

  format(name: string, row: number, col: number, numRows: number, numCols: number, style: Style): void {
    if (numRows < 1 || numCols < 1) return;
    const range = {
      sheetId: this.sheetId(name),
      startRowIndex: row - 1, endRowIndex: row - 1 + numRows,
      startColumnIndex: col - 1, endColumnIndex: col - 1 + numCols
    };
    const cellFormat: Record<string, unknown> = {};
    const fields: string[] = [];
    if (style.bg) { cellFormat['backgroundColor'] = hexToRgb(style.bg); fields.push('userEnteredFormat.backgroundColor'); }
    const text: Record<string, unknown> = {};
    if (style.fontColor) { text['foregroundColor'] = hexToRgb(style.fontColor); fields.push('userEnteredFormat.textFormat.foregroundColor'); }
    if (style.bold !== undefined) { text['bold'] = style.bold; fields.push('userEnteredFormat.textFormat.bold'); }
    if (Object.keys(text).length) cellFormat['textFormat'] = text;
    if (style.numberFormat) {
      cellFormat['numberFormat'] = { type: numberFormatType(style.numberFormat), pattern: style.numberFormat };
      fields.push('userEnteredFormat.numberFormat');
    }
    if (fields.length) {
      this.ops.push({
        kind: 'request', sheet: name,
        request: { repeatCell: { range, cell: { userEnteredFormat: cellFormat }, fields: fields.join(',') } }
      });
    }
    if (style.border) {
      const line = { style: 'SOLID' };
      const borders: Record<string, unknown> = { range, top: line, bottom: line, left: line, right: line };
      if (style.border === 'all') { borders['innerHorizontal'] = line; borders['innerVertical'] = line; }
      this.ops.push({ kind: 'request', sheet: name, request: { updateBorders: borders } });
    }
  }

  setColWidths(name: string, colStart: number, widths: number[]): void {
    for (let i = 0; i < widths.length; i++) {
      const w = widths[i];
      if (typeof w !== 'number' || w <= 0) continue;
      this.ops.push({
        kind: 'request', sheet: name,
        request: {
          updateDimensionProperties: {
            range: {
              sheetId: this.sheetId(name), dimension: 'COLUMNS',
              startIndex: colStart - 1 + i, endIndex: colStart + i
            },
            properties: { pixelSize: w },
            fields: 'pixelSize'
          }
        }
      });
    }
  }

  clear(name: string): void {
    this.cache[name] = [];
    this.ops.push({ kind: 'clear', sheet: name, range: quoteSheet(name) });
  }

  /** Граница батча. Сеть здесь не трогается — отправляет commit(). */
  flush(): void { this.batches++; }

  // --- внутреннее ---

  private grid(name: string): Grid {
    const g = this.cache[name];
    if (g === undefined) {
      throw new Error('ApiPort: вкладка «' + name + '» не загружена — сначала `await port.load([\'' +
        name + '\'])` (синхронное чтение по сети невозможно)');
    }
    return g;
  }

  private sheetId(name: string): number {
    const m = this.meta[name];
    if (!m) {
      throw new Error('ApiPort: нет sheetId вкладки «' + name + '» — форматирование требует ' +
        '`await port.load([...])`/`loadMeta()` и существующей вкладки');
    }
    return m.sheetId;
  }

  private applyToCache(name: string, row: number, col: number, rect: Cell[][]): void {
    const grid = this.cache[name] || (this.cache[name] = []);
    for (let r = 0; r < rect.length; r++) {
      while (grid.length < row + r) grid.push([]);
      const line = grid[row - 1 + r] as Cell[];
      const src = rect[r] as Cell[];
      while (line.length < col + src.length - 1) line.push('');
      for (let c = 0; c < src.length; c++) line[col - 1 + c] = src[c] as Cell;
    }
  }
}
