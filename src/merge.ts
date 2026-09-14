// Авто-слияние шардов: аддитивное сложение аккумуляторов без ручного перечисления полей.
//
// Заменяет рукописный aggregateStats игры (у sample-slot — 30 строк перечисления, где забытое поле
// молча теряется). Правила по умолчанию:
//   number                     → sum
//   плоская карта чисел        → поэлементное сложение с автосозданием ключей
//   карта объектов {n,coins,…} → поэлементное сложение каждого числового поля
//   строка/прочее              → первое непустое значение
// overrides: карта ключ→правило, `{ maxWin: 'max', maxSteps: 'max' }`.

import type { Stats } from './types.ts';

export type MergeRule = 'sum' | 'max' | 'min' | 'first';
export type MergeOverrides = Record<string, MergeRule>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function applyRule(prev: number | undefined, v: number, rule: MergeRule): number {
  if (prev === undefined) return v;
  if (rule === 'max') return v > prev ? v : prev;
  if (rule === 'min') return v < prev ? v : prev;
  if (rule === 'first') return prev;
  return prev + v;
}

// Карта: значения-числа складываются, значения-объекты сливаются по числовым полям.
function mergeMap(dst: Record<string, unknown>, src: Record<string, unknown>, rule: MergeRule): void {
  for (const k in src) {
    const v = src[k];
    if (typeof v === 'number') {
      const prev = dst[k];
      dst[k] = applyRule(typeof prev === 'number' ? prev : undefined, v, rule);
    } else if (isPlainObject(v)) {
      let cur = dst[k];
      if (!isPlainObject(cur)) { cur = {}; dst[k] = cur; }
      mergeMap(cur as Record<string, unknown>, v, rule);
    } else if (dst[k] === undefined || dst[k] === '') {
      dst[k] = v;
    }
  }
}

/**
 * Слить шарды в один аккумулятор. Ничего не мутирует: результат — новый объект.
 * Пустой список даёт пустой объект (состав полей задаёт newStats игры, не слияние).
 */
export function mergeStats<T extends Stats = Stats>(list: T[], overrides: MergeOverrides = {}): T {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < list.length; i++) {
    const st = list[i] as Record<string, unknown>;
    if (!st) continue;
    for (const k in st) {
      const v = st[k];
      const rule: MergeRule = overrides[k] || 'sum';
      if (typeof v === 'number') {
        const prev = out[k];
        out[k] = applyRule(typeof prev === 'number' ? prev : undefined, v, rule);
      } else if (isPlainObject(v)) {
        let cur = out[k];
        if (!isPlainObject(cur)) { cur = {}; out[k] = cur; }
        mergeMap(cur as Record<string, unknown>, v, rule);
      } else if (Array.isArray(v)) {
        // массивы поэлементно: редкий случай (профили длин), но молча терять его нельзя
        let cur = out[k];
        if (!Array.isArray(cur)) { cur = []; out[k] = cur; }
        const dst = cur as unknown[];
        for (let j = 0; j < v.length; j++) {
          const x = v[j];
          if (typeof x === 'number') {
            const prev = dst[j];
            dst[j] = applyRule(typeof prev === 'number' ? prev : undefined, x, rule);
          } else if (dst[j] === undefined) dst[j] = x;
        }
      } else if (out[k] === undefined || out[k] === '') {
        out[k] = v;
      }
    }
  }
  return out as T;
}
