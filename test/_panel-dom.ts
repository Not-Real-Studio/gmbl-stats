// Песочница панели: клиентский скрипт сгенерированного HTML гоняется в node поверх стабов
// `document`, `google.script.run` и `setTimeout`.
//
// Проверяется именно артефакт: скрипт вырезается из готовой страницы, а не импортируется
// отдельным модулем — иначе тест стерёг бы копию, а в HtmlService уезжало бы что-то другое.
// Вызовы серверных функций не резолвятся сами: тест держит их в полёте и отвечает руками —
// только так видно, СКОЛЬКО их одновременно (пул) и сколько писателей активно (NOT-255).

import vm from 'node:vm';

// --- DOM-стаб -----------------------------------------------------------------------------

class El {
  doc: Doc;
  tag: string;
  id = '';
  value = '';
  textContent: unknown = '';
  className = '';
  disabled = false;
  title = '';
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  children: El[] = [];

  constructor(doc: Doc, tag: string) { this.doc = doc; this.tag = tag; }

  get classList() {
    const self = this;
    return { contains(c: string) { return self.className.split(/\s+/).indexOf(c) >= 0; } };
  }

  get innerHTML(): string { return ''; }
  set innerHTML(_v: string) {
    for (const c of this.children) this.doc.unregister(c);
    this.children = [];
  }

  appendChild(c: El) { this.children.push(c); this.doc.register(c); }
}

class Doc {
  byId = new Map<string, El>();
  getElementById(id: string): El | null { return this.byId.get(id) ?? null; }
  createElement(tag: string): El { return new El(this, tag); }
  register(e: El) { if (e.id) this.byId.set(e.id, e); for (const c of e.children) this.register(c); }
  unregister(e: El) { if (e.id) this.byId.delete(e.id); for (const c of e.children) this.unregister(c); }
}

/** Элементы страницы: id + value из статического HTML (панель трогает только их). */
function parseDom(html: string): Doc {
  const doc = new Doc();
  const tags = /<(input|select|div|button|h3|option)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tags.exec(html))) {
    const attrs = m[2] as string;
    const id = /\bid="([^"]+)"/.exec(attrs);
    if (!id) continue;
    const el = doc.createElement(m[1] as string);
    el.id = id[1] as string;
    const value = /\bvalue="([^"]*)"/.exec(attrs);
    if (value) el.value = value[1] as string;
    const cls = /\bclass="([^"]*)"/.exec(attrs);
    if (cls) el.className = cls[1] as string;
    doc.register(el);
  }
  return doc;
}

// --- google.script.run --------------------------------------------------------------------

export interface Call {
  /** Имя серверной функции: 'oa2ComputeShard'. */
  name: string;
  args: unknown[];
  done: boolean;
  /** Ответить успехом (значение уедет в withSuccessHandler). */
  ok(value?: unknown): void;
  /** Ответить ошибкой (в withFailureHandler уедет {message}). */
  fail(message: string): void;
}

export interface Panel {
  html: string;
  doc: Doc;
  /** Все вызовы серверных функций в порядке появления. */
  calls: Call[];
  /** Незавершённые вызовы; `name` — подстрока имени ('ComputeShard'). */
  inFlight(name?: string): Call[];
  /** Все вызовы по подстроке имени, включая завершённые. */
  seen(name: string): Call[];
  /** Значение поля + его onchange (панель пересчитывает оценку и сетку). */
  set(id: string, value: string | number): void;
  el(id: string): El;
  /** Лог сверху вниз (первая строка — последнее событие). */
  log(): string[];
  /** Выполнить накопленные setTimeout (ретраи записи). */
  tick(): void;
  timers: number;
  /** Выражение в контексте панели: `exec('runAll()')`, `exec('queue.length')`. */
  exec(js: string): unknown;
}

/** Загрузить панель: DOM собран, скрипт исполнен, `{prefix}PanelInfo` уже в полёте. */
export function loadPanel(html: string): Panel {
  const doc = parseDom(html);
  const calls: Call[] = [];
  const timers: Array<() => void> = [];

  function runner() {
    const h: { ok?: (v: unknown) => void; fail?: (e: unknown) => void } = {};
    const target: Record<string, unknown> = {};
    const proxy: unknown = new Proxy(target, {
      get(_t, prop: string) {
        if (prop === 'withSuccessHandler') return (f: (v: unknown) => void) => { h.ok = f; return proxy; };
        if (prop === 'withFailureHandler') return (f: (e: unknown) => void) => { h.fail = f; return proxy; };
        return (...args: unknown[]) => {
          const call: Call = {
            name: prop, args, done: false,
            ok(value?: unknown) {
              if (call.done) throw new Error('повторный ответ на ' + prop);
              call.done = true;
              if (h.ok) h.ok(value);
            },
            fail(message: string) {
              if (call.done) throw new Error('повторный ответ на ' + prop);
              call.done = true;
              if (h.fail) h.fail({ message });
            }
          };
          calls.push(call);
          return proxy;
        };
      }
    });
    return proxy;
  }

  const sandbox = {
    document: doc,
    google: { script: { get run() { return runner(); } } },
    setTimeout(fn: () => void) { timers.push(fn); return timers.length; },
    console
  };
  vm.createContext(sandbox);

  const src = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!src) throw new Error('в HTML панели нет <script>');
  vm.runInContext(src[1] as string, sandbox, { filename: 'panel.js' });

  const panel: Panel = {
    html, doc, calls,
    inFlight(name?: string) {
      return calls.filter((c) => !c.done && (!name || c.name.indexOf(name) >= 0));
    },
    seen(name: string) { return calls.filter((c) => c.name.indexOf(name) >= 0); },
    el(id: string) {
      const e = doc.getElementById(id);
      if (!e) throw new Error('нет элемента #' + id);
      return e;
    },
    set(id: string, value: string | number) {
      const e = panel.el(id);
      e.value = String(value);
      if (e.onchange) e.onchange();
    },
    log() { return String(panel.el('log').textContent).split('\n'); },
    tick() { const due = timers.splice(0, timers.length); for (const fn of due) fn(); },
    get timers() { return timers.length; },
    exec(js: string) { return vm.runInContext(js, sandbox); }
  };
  return panel;
}

/** Ответ `{prefix}PanelInfo` по умолчанию. */
export const INFO = {
  profiles: ['rtp96', 'rtp94'],
  modes: ['base', 'buy'],
  defaultRounds: 100000,
  defaultShards: 4,
  defaultSeed: 20260803,
  configHash: 'abcd1234',
  buckets: 42,
  lastRun: '03.08.2026',
  saved: null as Record<string, unknown> | null
};

/** Загрузить панель и ответить на стартовые PanelInfo/CheckStale. */
export function bootPanel(html: string, info: Partial<typeof INFO> = {}): Panel {
  const panel = loadPanel(html);
  const first = panel.inFlight('PanelInfo')[0];
  if (!first) throw new Error('панель не позвала PanelInfo');
  first.ok({ ...INFO, ...info });
  const stale = panel.inFlight('CheckStale')[0];
  if (stale) stale.ok({ ready: true, columns: 0, stale: 0, hash: 'abcd1234' });
  return panel;
}

/** Ответ `{prefix}ComputeShard` для колонки i. */
export function shardResult(i: number, rounds = 400000, seconds = 12): Record<string, unknown> {
  return { shard: i, rounds, seconds, rtp: 96.1234, hash: 'abcd1234', profile: 'rtp96', mode: 'base', seed: 20260803 + i - 1, rows: [] };
}

/** Ответ `{prefix}WriteRun`. */
export function writeResult(columns: number, committed = columns): Record<string, unknown> {
  return { columns, committed, rtp: 96.1 };
}
