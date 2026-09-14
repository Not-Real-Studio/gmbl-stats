// Минимальный вычислитель формул Sheets — ровно тот поднабор, который генерирует grid.ts:
// IF / IFERROR / SUM / MAX / MIN / SQRT / ABS / SUMPRODUCT / INDEX / FILTER, ссылки на ячейки и
// диапазоны одной вкладки, арифметика и сравнения `=` / `<>`.
//
// Зачем: §3.1 требует, чтобы агрегация КОДОМ (aggregateRows) давала те же числа, что формулы в
// шите. Проверить это можно только исполнив сами формулы — пересказ формул в тесте проверял бы
// пересказ. Разделитель аргументов принимаем и `,` и `;` (диалект ru_RU).
//
// Порт test/_sheet-eval.mjs из sample-slot (тестовая машинерия, не часть пакета).

/* eslint-disable @typescript-eslint/no-explicit-any */
type Val = any;

const FUNCS = new Set(['IF', 'IFERROR', 'SUM', 'MAX', 'MIN', 'SQRT', 'ABS', 'SUMPRODUCT', 'INDEX', 'FILTER']);

interface Tok { k: 'str' | 'op' | 'num' | 'name'; v: any }

function tokenize(src: string): Tok[] {
  const t: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ') { i++; continue; }
    if (ch === '"') {
      let s = '';
      i++;
      while (i < src.length && src[i] !== '"') s += src[i++];
      i++;
      t.push({ k: 'str', v: s });
      continue;
    }
    if (ch === '<' && src[i + 1] === '>') { t.push({ k: 'op', v: '<>' }); i += 2; continue; }
    if ('+-*/=(),;:'.includes(ch)) { t.push({ k: 'op', v: ch }); i++; continue; }
    if (/[0-9]/.test(ch)) {
      let s = '';
      while (i < src.length && /[0-9.]/.test(src[i] as string)) s += src[i++];
      t.push({ k: 'num', v: parseFloat(s) });
      continue;
    }
    if (/[A-Za-z$]/.test(ch)) {
      let s = '';
      while (i < src.length && /[A-Za-z0-9$_.]/.test(src[i] as string)) s += src[i++];
      t.push({ k: 'name', v: s });
      continue;
    }
    throw new Error(`sheet-eval: неожиданный символ «${ch}» в «${src}»`);
  }
  return t;
}

function colToIndex(name: string): number {
  let n = 0;
  for (const c of name) n = n * 26 + (c.charCodeAt(0) - 64);
  return n; // 1-based
}
function parseRef(name: string): { col: number; row: number } | null {
  const m = /^\$?([A-Z]+)\$?([0-9]+)$/.exec(name.toUpperCase());
  return m ? { col: colToIndex(m[1] as string), row: parseInt(m[2] as string, 10) } : null;
}

const isNum = (v: Val): boolean => typeof v === 'number' && isFinite(v);
const toNum = (v: Val): number => (isNum(v) ? v : v === '' || v == null || typeof v === 'string' ? 0 : Number(v) || 0);
const truthy = (v: Val): boolean => v === true || (isNum(v) && v !== 0);
const eq = (a: Val, b: Val): boolean => {
  if (a === '' || a == null) return b === '' || b == null;
  return String(a) === String(b);
};
const flat = (a: Val[]): Val[] => a.reduce((acc: Val[], v: Val) => acc.concat(Array.isArray(v) ? v : [v]), []);

/** value(row, col) — значение ячейки (1-based), уже вычисленное. */
export function evalFormula(src: string, value: (row: number, col: number) => Val): Val {
  const t = tokenize(src.startsWith('=') ? src.slice(1) : src);
  let p = 0;
  const peek = (): Tok | undefined => t[p];
  const eat = (v?: any): Tok => {
    if (!t[p] || (v !== undefined && (t[p] as Tok).v !== v)) throw new Error(`sheet-eval: ожидалось «${v}» в «${src}»`);
    return t[p++] as Tok;
  };
  const isSep = (tok: Tok | undefined): boolean => !!tok && tok.k === 'op' && (tok.v === ',' || tok.v === ';');

  function args(): Val[] {
    const out: Val[] = [];
    eat('(');
    if (peek() && (peek() as Tok).v === ')') { eat(')'); return out; }
    for (;;) {
      out.push(expr());
      if (isSep(peek())) { p++; continue; }
      eat(')');
      return out;
    }
  }

  function primary(): Val {
    const tok = peek();
    if (!tok) throw new Error(`sheet-eval: неожиданный конец «${src}»`);
    if (tok.k === 'num') { p++; return tok.v; }
    if (tok.k === 'str') { p++; return tok.v; }
    if (tok.k === 'op' && tok.v === '(') { p++; const v = expr(); eat(')'); return v; }
    if (tok.k === 'op' && tok.v === '-') { p++; return -toNum(primary()); }
    if (tok.k === 'name') {
      const up = String(tok.v).toUpperCase();
      if (FUNCS.has(up)) { p++; return call(up); }
      p++;
      const a = parseRef(String(tok.v));
      if (!a) throw new Error(`sheet-eval: не ссылка и не функция: «${tok.v}»`);
      if (peek() && (peek() as Tok).v === ':') {
        p++;
        const b = parseRef(String(eat().v));
        if (!b) throw new Error(`sheet-eval: не ссылка после «:» в «${src}»`);
        const out: Val[] = [];
        for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++) {
          for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) out.push(value(r, c));
        }
        return out;
      }
      return value(a.row, a.col);
    }
    throw new Error(`sheet-eval: не разобрано «${src}» на позиции ${p}`);
  }

  // Аргументы как диапазоны токенов — нужны IFERROR (второй аргумент вычисляется, только если
  // первый упал: `=IFERROR(INDEX(FILTER(...)),"")` на пустом диапазоне обязан дать "", а не ошибку).
  function argSpans(): Array<[number, number]> {
    eat('(');
    const spans: Array<[number, number]> = [];
    let depth = 0, start = p;
    for (;;) {
      const tok = t[p];
      if (!tok) throw new Error(`sheet-eval: незакрытая скобка в «${src}»`);
      if (tok.v === '(') depth++;
      else if (tok.v === ')') {
        if (depth === 0) { spans.push([start, p]); p++; return spans; }
        depth--;
      } else if (depth === 0 && isSep(tok)) { spans.push([start, p]); start = p + 1; }
      p++;
    }
  }
  function evalSpan(span: [number, number]): Val {
    const save = p;
    p = span[0];
    const v = expr();
    if (p !== span[1]) { p = save; throw new Error(`sheet-eval: аргумент разобран не целиком в «${src}»`); }
    p = save;
    return v;
  }

  function call(name: string): Val {
    if (name === 'IFERROR') {
      const spans = argSpans();
      try { return evalSpan(spans[0] as [number, number]); } catch {
        return spans[1] ? evalSpan(spans[1]) : '';
      }
    }
    const a = args();
    switch (name) {
      case 'IF': return truthy(a[0]) ? a[1] : (a.length > 2 ? a[2] : false);
      case 'SUM': return flat(a).reduce((s: number, v: Val) => s + toNum(v), 0);
      case 'MAX': { const n = flat(a).filter(isNum); return n.length ? Math.max(...n) : 0; }
      case 'MIN': { const n = flat(a).filter(isNum); return n.length ? Math.min(...n) : 0; }
      case 'SQRT': return Math.sqrt(toNum(a[0]));
      case 'ABS': return Math.abs(toNum(a[0]));
      case 'SUMPRODUCT': {
        const arrs = a.map((x: Val) => (Array.isArray(x) ? x : [x]));
        let s = 0;
        for (let i = 0; i < (arrs[0] as Val[]).length; i++) {
          let m = 1;
          for (const arr of arrs) m *= toNum((arr as Val[])[i]);
          s += m;
        }
        return s;
      }
      case 'INDEX': {
        const arr = Array.isArray(a[0]) ? a[0] : [a[0]];
        const i = toNum(a[1]);
        if (i < 1 || i > arr.length) throw new Error('#REF!');
        return arr[i - 1];
      }
      case 'FILTER': {
        const arr = Array.isArray(a[0]) ? a[0] : [a[0]];
        const cond = Array.isArray(a[1]) ? a[1] : [a[1]];
        const out = arr.filter((_: Val, i: number) => truthy(cond[i]));
        if (!out.length) throw new Error('#N/A');
        return out;
      }
      default: throw new Error(`sheet-eval: функция ${name} не поддержана`);
    }
  }

  function mul(): Val {
    let v = primary();
    while (peek() && (peek() as Tok).k === 'op' && ((peek() as Tok).v === '*' || (peek() as Tok).v === '/')) {
      const op = eat().v;
      const r = primary();
      v = op === '*' ? toNum(v) * toNum(r) : toNum(v) / toNum(r);
    }
    return v;
  }
  function add(): Val {
    let v = mul();
    while (peek() && (peek() as Tok).k === 'op' && ((peek() as Tok).v === '+' || (peek() as Tok).v === '-')) {
      const op = eat().v;
      const r = mul();
      v = op === '+' ? toNum(v) + toNum(r) : toNum(v) - toNum(r);
    }
    return v;
  }
  function expr(): Val {
    const l = add();
    if (peek() && (peek() as Tok).k === 'op' && ((peek() as Tok).v === '=' || (peek() as Tok).v === '<>')) {
      const op = eat().v;
      const r = add();
      const cmp = (x: Val, y: Val): boolean => (op === '=' ? eq(x, y) : !eq(x, y));
      if (Array.isArray(l)) return l.map((x: Val) => cmp(x, r));
      return cmp(l, r);
    }
    return l;
  }

  const res = expr();
  if (p !== t.length) throw new Error(`sheet-eval: хвост после разбора «${src}»`);
  return res;
}

/** Вычислитель по 2D-гриду (1-based доступ), с мемоизацией и детектом циклов. */
export function sheetEvaluator(data: Val[][]): (row: number, col: number) => Val {
  const memo = new Map<string, Val>();
  const busy = new Set<string>();
  function value(row: number, col: number): Val {
    const key = row + ':' + col;
    if (memo.has(key)) return memo.get(key);
    const raw = (data[row - 1] || [])[col - 1];
    if (typeof raw !== 'string' || raw[0] !== '=') return raw === undefined || raw === null ? '' : raw;
    if (busy.has(key)) throw new Error(`sheet-eval: цикл в ячейке ${key}`);
    busy.add(key);
    let v: Val;
    try { v = evalFormula(raw, value); } finally { busy.delete(key); }
    memo.set(key, v);
    return v;
  }
  return value;
}
