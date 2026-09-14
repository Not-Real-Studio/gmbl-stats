// panel — генератор HTML сайдбара прогона (оркестрация на клиенте).
//
// Счётный слой уехал в ядро давно (table.ts), оркестрация — нет: она жила копией sidebar.html
// в каждом слоте, и третья копия разошлась ровно там, где дороже всего (последовательный счёт
// и запись одним вызовом в конце — прерванный прогон терял всё). Здесь она одна на всех.
//
// Инвариант, ради которого всё написано (урок NOT-255, см. шапку table.ts): параллельные
// GAS-исполнения, пишущие один шит, теряют записи ДАЖЕ ПОД ЛОКОМ — мутации применяются к
// ревизии документа, открытой на старте исполнения. Отсюда конструкция панели:
//   K параллельных `{prefix}ComputeShard` (чистый счёт, шита не касаются)
//     → очередь готовых колонок
//       → РОВНО ОДИН активный `{prefix}WriteRun` в каждый момент времени.
// Ни LockService, ни записи из шарда здесь быть не может: это чинили дважды.
//
// Серверных функций панель не добавляет ни одной: зовёт ровно то, что зовёт эталон
// (`sample-slot/gas/sidebar.html`), имена строятся из префикса слота. Единственное, что слот
// собирал руками, — ответ `PanelInfo`; его собирает `statsPanelInfo` (см. подвал файла).

import type { SheetPort } from './port.ts';
import type { SavedParams, StatsAdapter, TableOptions } from './table.ts';
import { statsAggregateFromSheet, statsConfigHash, statsReadParams } from './table.ts';
import { statBuckets } from './buckets.ts';
import { rowsByLabel, L_DATE } from './aggregate.ts';

/** Что слот отдаёт панели: только своё — имя, префикс, подписи, дефолты. */
export interface PanelSpec {
  /** Заголовок сайдбара: «SIM — Sample Slot». */
  title: string;
  /** Префикс серверных функций: 'oa2' → oa2PrepareRun, oa2ComputeShard, … */
  prefix: string;
  /** title= для селекта режимов (у каждой игры свои режимы и свои оговорки). */
  modesHint?: string;
  /** Стартовые значения полей до ответа `{prefix}PanelInfo`. `rounds` — НА КОЛОНКУ. */
  defaults?: { rounds?: number; shards?: number; seed?: number };
  /** Потолок ОДНОВРЕМЕННЫХ исполнений (не колонок). Дефолт — `statsPanelLimits.maxShards`. */
  maxShards?: number;
}

/**
 * Числа панели — здесь, а не в HTML: пороги и потолки должны править в одном месте.
 * `roundsPerSec` — оценка скорости ДО замера (порядок GAS-исполнения слота); после «Замера
 * скорости» панель считает по измеренной.
 */
export interface PanelLimits {
  /** Одновременных `google.script.run` в полёте (у Google порядка 30 на пользователя). */
  maxShards: number;
  /** Жёсткий лимит одного GAS-исполнения, с. */
  execLimitSec: number;
  /** Потолок оценки на колонку, с: выше — Run гаснет, до лимита исполнения не дотянуть. */
  shardBudgetSec: number;
  /** Скорость счёта по умолчанию, раундов/с. */
  roundsPerSec: number;
  /** Раундов в малом пробном прогоне (им меряются накладные). */
  probeBaseRounds: number;
  /** Раундов в большом пробном прогоне. */
  probeRounds: number;
  /** Попыток записи очереди. */
  writeRetries: number;
  /** Пауза между попытками записи, мс. */
  writeRetryMs: number;
}

export const statsPanelLimits: PanelLimits = {
  maxShards: 30,
  execLimitSec: 360,
  shardBudgetSec: 300,
  roundsPerSec: 20000,
  probeBaseRounds: 20000,
  probeRounds: 200000,
  writeRetries: 3,
  writeRetryMs: 2000
};

const ID = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
  body { font: 12px/1.45 Arial, sans-serif; margin: 8px; color: #222; }
  h3 { margin: 0 0 8px; font-size: 14px; }
  label { display: block; margin: 7px 0 2px; font-size: 11px; color: #555; font-weight: bold; }
  select, input { width: 100%; box-sizing: border-box; padding: 5px; border: 1px solid #ccc; border-radius: 4px; }
  .row { display: flex; gap: 6px; } .row > div { flex: 1; }
  button { margin: 8px 4px 0 0; padding: 7px 10px; border: none; border-radius: 5px; cursor: pointer;
    background: #2e7d32; color: #fff; font-weight: bold; }
  button.sec { background: #546e7a; }
  button:disabled { background: #9e9e9e; cursor: wait; }
  #state { margin: 0 0 4px; font-size: 10px; color: #777; }
  #per { margin-top: 3px; font-size: 10px; color: #777; }
  #per.bad { color: #c62828; font-weight: bold; }
#per.warn { color: #e65100; font-weight: bold; }
  #grid { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 10px; }
  .s { width: 30px; height: 26px; border: 1px solid #bbb; background: #f5f5f5; font-size: 11px;
    cursor: pointer; border-radius: 3px; }
  .s.run { background: #ffe08a } .s.ok { background: #b7e1a1 } .s.wr { background: #90caf9 } .s.err { background: #f4a9a1 }
  #log { margin-top: 8px; padding: 6px; background: #f7f7f7; border: 1px solid #e0e0e0;
    white-space: pre-wrap; font: 11px/1.4 Consolas, monospace; max-height: 220px; overflow: auto; }
  .hint { margin-top: 8px; font-size: 10px; color: #999; }
`;

/**
 * Клиентская логика панели. ES5 без template-строк: файл едет в HtmlService как есть, а `${…}`
 * внутри сломал бы генерацию. Всё game-specific — только через `p` (префикс) и `LIM`.
 */
function script(p: string, limits: PanelLimits): string {
  return `
  var LIM = ${JSON.stringify(limits)};

  var done = 0, failed = 0, total = 0, queue = [], writing = false, retries = 0;
  var pending = [], inflight = 0, running = false;
  var speed = LIM.roundsPerSec, overhead = 0, blocked = false;
  var hdr = { buckets: 0, hash: '', columns: -1, stale: 0, lastRun: '' };

  function log(m) { var l = document.getElementById('log'); l.textContent = m + '\\n' + l.textContent; }
  function V(id) { return document.getElementById(id).value; }
  function K() { return parseInt(V('shards'), 10) || 1; }

  // Поле — ИТОГО раундов на прогон: боевой объём меряют суммой («20M на 50 колонок» — это 20 млн
  // всего, а не на каждую). Серверные функции получают раунды НА КОЛОНКУ.
  function perShard() { return Math.max(1, Math.floor((parseInt(V('rounds'), 10) || 1) / K())); }

  function params() {
    return { profile: V('profile'), mode: V('mode'), shards: K(),
      rounds: perShard(), seed: parseInt(V('seed'), 10) };
  }
  function busy(on) {
    running = on;
    document.getElementById('run').disabled = on;
    document.getElementById('probe').disabled = on;
  }

  function renderState() {
    var a = [];
    if (hdr.buckets) a.push('бакетов в лестнице ' + hdr.buckets);
    if (hdr.hash) a.push('hash ' + hdr.hash);
    if (hdr.columns >= 0) a.push('колонок ' + hdr.columns + (hdr.stale ? ', протухших ' + hdr.stale : ''));
    if (hdr.lastRun) a.push('прогон ' + hdr.lastRun);
    document.getElementById('state').textContent = a.length ? a.join(' · ') : '—';
  }

  // Колонка — одно GAS-исполнение со своим лимитом (LIM.execLimitSec). Оценка выше бюджета —
  // ПРЕДУПРЕЖДЕНИЕ, а не запрет: она строится на пробном прогоне, который на коротких выборках
  // занижает скорость (GAS не успевает прогреться), и запрет по кривой оценке ломает прогоны,
  // которые на деле укладываются. Решает человек — он знает свой слот.
  function recheck() {
    var n = perShard(), est = overhead + n / speed, was = blocked;
    blocked = est > LIM.shardBudgetSec;
    var el = document.getElementById('per');
    el.textContent = 'на колонку: ' + n + ' раундов ≈ ' + est.toFixed(0) + 'с' +
      (blocked ? ' — оценка выше ' + LIM.shardBudgetSec + 'с (лимит исполнения ' +
        LIM.execLimitSec + 'с), колонка может не успеть' : '');
    el.className = blocked ? 'warn' : '';
    document.getElementById('run').disabled = running;
    if (blocked && !was) log('Внимание: ' + n + ' раундов на колонку ≈ ' + est.toFixed(0) +
      'с при ' + Math.round(speed) + ' раунд/с. Оценка приблизительная — если колонки падают ' +
      'по таймауту, добавьте колонок.', 'warn');
  }

  function cells() {
    var g = document.getElementById('grid'); g.innerHTML = ''; done = 0; failed = 0;
    for (var i = 1; i <= K(); i++) {
      var b = document.createElement('button');
      b.className = 's'; b.id = 's' + i; b.textContent = i;
      b.onclick = (function (k) { return function () { total = Math.max(total, k); compute(k, collect); }; })(i);
      g.appendChild(b);
    }
  }

  function init() {
    google.script.run.withSuccessHandler(function (info) {
      var sel = document.getElementById('profile'); sel.innerHTML = '';
      (info.profiles || []).forEach(function (p) {
        var o = document.createElement('option'); o.value = p; o.textContent = p; sel.appendChild(o);
      });
      var ms = document.getElementById('mode'); ms.innerHTML = '';
      (info.modes || ['base']).forEach(function (m) {
        var o = document.createElement('option'); o.value = m; o.textContent = m; ms.appendChild(o);
      });
      var s = info.saved || {};
      var shards = Number(s.shards || info.defaultShards) || 0;
      var each = Number(s.spins || info.defaultRounds) || 0;
      if (shards) document.getElementById('shards').value = shards;
      if (each) document.getElementById('rounds').value = each * (shards || 1);
      if (s.seed || info.defaultSeed) document.getElementById('seed').value = s.seed || info.defaultSeed;
      if (s.profile) sel.value = s.profile;
      if (s.mode) ms.value = s.mode;
      cells();
      hdr.hash = info.configHash || '';
      hdr.buckets = Number(info.buckets) || 0;
      hdr.lastRun = info.lastRun || '';
      renderState();
      log('Конфиг документа: hash ' + info.configHash);
      recheck();
      checkStale();
    }).withFailureHandler(function (e) { log('Ошибка загрузки панели: ' + e.message); }).${p}PanelInfo();
  }

  // Сверка колонок с текущим конфигом: хэш считает движок, формулы строки 3 его сравнивают.
  function checkStale() {
    google.script.run
      .withSuccessHandler(function (r) {
        if (!r.ready || !r.columns) return;
        hdr.columns = r.columns; hdr.stale = r.stale; renderState();
        log(r.stale ? ('ВНИМАНИЕ: протухших колонок ' + r.stale + ' из ' + r.columns +
          ' — конфиг правили после прогона, прогоняйте заново') : ('колонок в stats: ' + r.columns + ', все актуальны'));
      })
      .withFailureHandler(function (e) { log('Проверка протухания: ' + e.message); })
      .${p}CheckStale(V('profile'));
  }

  // Замер скорости: два прогона разного объёма. Накладные (сборка конфига, манифест) от числа
  // раундов не зависят — их даёт разность замеров, поэтому меряются отдельно и вычитаются.
  function probe() {
    function fail(e) { busy(false); recheck(); log('ОШИБКА замера: ' + e.message); }
    function probeParams(n) { var q = params(); q.rounds = n; return q; }
    busy(true);
    log('Замер скорости: пробные прогоны ' + LIM.probeBaseRounds + ' и ' + LIM.probeRounds + ' раундов…');
    google.script.run
      .withSuccessHandler(function (a) {
        google.script.run
          .withSuccessHandler(function (b) {
            busy(false);
            var dr = b.rounds - a.rounds, dt = b.seconds - a.seconds;
            if (dr > 0 && dt > 0) {
              speed = dr / dt;
              overhead = Math.max(0, a.seconds - a.rounds / speed);
              log('Замер: ' + Math.round(speed) + ' раунд/с, накладные ' + overhead.toFixed(2) + 'с.');
            } else {
              log('Замер неточен (прогоны быстрее разрешения таймера) — скорость по умолчанию.');
            }
            recheck();
          })
          .withFailureHandler(fail)
          .${p}ComputeShard(1, probeParams(LIM.probeRounds));
      })
      .withFailureHandler(fail)
      .${p}ComputeShard(1, probeParams(LIM.probeBaseRounds));
  }

  function compute(i, onDone) {
    var b = document.getElementById('s' + i);
    if (!b || b.classList.contains('run')) return;
    b.className = 's run'; inflight++;
    google.script.run
      .withSuccessHandler(function (r) {
        b.className = 's ok'; done++; inflight--;
        log('колонка ' + i + ': ' + r.rounds + ' раундов, RTP ' + r.rtp.toFixed(4) + '% за ' + r.seconds.toFixed(1) + 'с');
        onDone(r, i); pump();
      })
      .withFailureHandler(function (e) {
        b.className = 's err'; failed++; inflight--;
        log('колонка ' + i + ' ОШИБКА: ' + e.message);
        onDone(null, i); pump();
      })
      .${p}ComputeShard(i, params());
  }

  // Потолок одновременных исполнений: в полёте не больше LIM.maxShards, освободилось —
  // стартует следующая. Полсотни колонок разом Google не даст, а очередь на клиенте — даст.
  function pump() {
    while (inflight < LIM.maxShards && pending.length) compute(pending.shift(), collect);
  }

  // Писатель один (иначе параллельные исполнения теряют записи, урок NOT-255).
  function writeRun() {
    if (writing || !queue.length) return;
    var batch = queue.splice(0, queue.length); writing = true;
    batch.forEach(function (r) { var b = document.getElementById('s' + r.shard); if (b) b.className = 's wr'; });
    google.script.run
      .withSuccessHandler(function (w) {
        writing = false; retries = 0;
        batch.forEach(function (r) { var b = document.getElementById('s' + r.shard); if (b) b.className = 's ok'; });
        log('записано +' + w.columns + ' → агрегат ' + w.committed + ' колонк(и), RTP ' +
          (typeof w.rtp === 'number' ? w.rtp.toFixed(4) + '%' : '—'));
        writeRun(); finale();
      })
      .withFailureHandler(function (e) {
        writing = false; retries++;
        if (retries <= LIM.writeRetries) {
          log('ОШИБКА записи (попытка ' + retries + '/' + LIM.writeRetries + ', ретрай через ' +
            (LIM.writeRetryMs / 1000) + 'с): ' + e.message);
          queue = batch.concat(queue); setTimeout(writeRun, LIM.writeRetryMs);
        } else { log('ОШИБКА записи, ' + batch.length + ' колонок не записано: ' + e.message); finale(); }
      })
      .${p}WriteRun(batch, params());
  }

  function collect(r) { if (r) { queue.push(r); writeRun(); } else finale(); }
  function finale() {
    if (done + failed === total && !pending.length && !queue.length && !writing) {
      busy(false);
      log(failed ? ('Готово, ошибок счёта: ' + failed) : 'Все колонки записаны.');
    }
  }

  function runAll() {
    if (blocked) { recheck(); }
    busy(true); total = K(); queue = []; writing = false; retries = 0; inflight = 0; cells();
    pending = []; for (var i = 1; i <= total; i++) pending.push(i);
    log('Инициализация вкладки stats (' + V('profile') + ' × ' + V('mode') + ', ' + total + ' колонок)…');
    google.script.run
      .withSuccessHandler(function (r) {
        log('Скелет: ' + r.rows + ' строк манифеста, hash ' + r.hash + '. Запуск ' + total +
          ' параллельных исполнений, одновременно не больше ' + LIM.maxShards + '…');
        pump();
      })
      .withFailureHandler(function (e) { busy(false); log('ОШИБКА init: ' + e.message); })
      .${p}PrepareRun(V('profile'), V('mode'), total, { rounds: perShard(), seed: parseInt(V('seed'), 10) });
  }

  function commit() {
    log('Врайтбек actual_* из агрегата…');
    google.script.run
      .withSuccessHandler(function (r) {
        log('profiles ← ' + r.written + ' строк actual_* (' + r.profile + ' × ' + r.mode +
          ', колонок в агрегате ' + r.columns + ', hash ' + r.hash + ')');
      })
      .withFailureHandler(function (e) { log('ОШИБКА врайтбека: ' + e.message); })
      .${p}WriteActuals(V('profile'), V('mode'));
  }

  function resync() {
    log('Пересборка колонки statSummary…');
    google.script.run
      .withSuccessHandler(function (r) { log('statSummary: колонка ' + r.col + ' (' + r.columns + ' шардов, ' + r.rows + ' строк)'); })
      .withFailureHandler(function (e) { log('ОШИБКА: ' + e.message); })
      .${p}CommitSummary(V('profile'), V('mode'));
  }

  function reset() {
    log('Сброс вкладки stats…');
    google.script.run
      .withSuccessHandler(function () { cells(); log('stats очищена — следующий прогон соберёт скелет заново.'); })
      .withFailureHandler(function (e) { log('ОШИБКА: ' + e.message); })
      .${p}ClearStats();
  }

  document.getElementById('shards').onchange = function () { cells(); recheck(); };
  document.getElementById('rounds').onchange = recheck;
  init();
`;
}

/**
 * HTML сайдбара прогона: слот кладёт результат в `HtmlService.createHtmlOutput(...)`, своего
 * `sidebar.html` у слота больше нет.
 *
 * Панель зовёт ровно восемь серверных функций слота, имена — из `prefix`: `PanelInfo`,
 * `PrepareRun`, `ComputeShard`, `WriteRun`, `CommitSummary`, `WriteActuals`, `CheckStale`,
 * `ClearStats`. Ни одной сверх этого списка.
 */
export function statsPanelHtml(spec: PanelSpec): string {
  const p = String(spec && spec.prefix || '');
  if (!ID.test(p)) {
    throw new Error('statsPanelHtml: prefix «' + p + '» не идентификатор JS (из него строятся имена вызовов)');
  }
  const d = spec.defaults || {};
  const limits: PanelLimits = {
    ...statsPanelLimits,
    maxShards: Math.max(1, Math.floor(Number(spec.maxShards) || statsPanelLimits.maxShards))
  };
  const shards = Math.max(1, Math.floor(Number(d.shards) || 4));
  const each = Math.max(1, Math.floor(Number(d.rounds) || 100000));
  const seed = Math.floor(Number(d.seed) || 0);
  const modesHint = spec.modesHint ? ' title="' + esc(spec.modesHint) + '"' : '';

  return `<!DOCTYPE html>
<html>
<head>
<base target="_top">
<style>${STYLE}</style>
</head>
<body>
  <h3>${esc(spec.title)}</h3>
  <div id="state">—</div>

  <label for="profile">Профиль</label>
  <select id="profile"></select>

  <label for="mode"${modesHint}>Режим</label>
  <select id="mode"></select>

  <div class="row">
    <div><label for="rounds">Итого раундов</label><input id="rounds" type="number" min="1" step="10000" value="${each * shards}"></div>
    <div><label for="shards">Колонок</label><input id="shards" type="number" min="1" value="${shards}"></div>
  </div>
  <div id="per"></div>

  <label for="seed">Seed (колонка i → seed+i−1)</label>
  <input id="seed" type="number" value="${seed}">

  <button id="run" onclick="runAll()" title="init скелета → K параллельных исполнений → запись колонок + агрегат в statSummary">Прогнать все</button>
  <button class="sec" id="probe" onclick="probe()" title="Два пробных прогона: скорость раундов/с и накладные — из них оценка времени колонки">Замер скорости</button>
  <button class="sec" onclick="commit()" title="Агрегат → actual_* в profiles (адресно, по имени строки)">Commit actual_*</button>
  <button class="sec" onclick="resync()" title="Пересобрать колонку statSummary из текущего агрегата">Re-sync statSummary</button>
  <button class="sec" onclick="reset()" title="Стереть вкладку stats целиком">Сбросить stats</button>

  <div id="grid"></div>
  <div id="log">Готов.</div>
  <div class="hint">Каждая колонка — своё GAS-исполнение со своим лимитом 6 мин. Агрегат (колонка C)
    считается формулами: средние взвешены по Rounds, STD пулом. Врайтбек — только поверх агрегата.</div>

<script>${script(p, limits)}</script>
</body>
</html>
`;
}

// --- PanelInfo: то единственное, что слот собирал руками --------------------------------------

/** Ответ `{prefix}PanelInfo`: чем панель заполняет селекты, поля и шапку состояния. */
export interface PanelInfo {
  profiles: string[];
  modes: string[];
  /** Раундов НА КОЛОНКУ (панель умножит на колонки и покажет итого). */
  defaultRounds: number;
  defaultShards: number;
  defaultSeed: number;
  configHash: string;
  /** Бакетов в лестнице распределения — сколько строк займёт витрина. */
  buckets: number;
  /** Дата последнего прогона, `дд.мм.гггг`; вкладки нет — пустая строка. */
  lastRun: string;
  saved: SavedParams | null;
}

/** Google serial (дни с 1899-12-30) → `дд.мм.гггг`. Календарь считает Date, часов не берём. */
function dmy(serial: number): string {
  const d = new Date(Math.round((serial - 25569) * 86400000));
  const pad = (n: number) => (n < 10 ? '0' + n : String(n));
  return pad(d.getUTCDate()) + '.' + pad(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear();
}

function lastRunOf(port: SheetPort, opts: TableOptions): string {
  let date: unknown;
  // Дату шит отдаёт serial-числом, а GasPort из date-форматированной ячейки — объектом Date.
  try { date = rowsByLabel(statsAggregateFromSheet(port, opts))[L_DATE]; }
  catch { return ''; }                       // вкладки нет или она пуста — прогона не было
  if (date instanceof Date) return dmy(date.getTime() / 86400000 + 25569);
  if (typeof date === 'number' && isFinite(date)) return dmy(date);
  return date ? String(date) : '';
}

/**
 * Ответ `PanelInfo` целиком из адаптера и вкладки: у слота остаётся однострочная обёртка
 * `function oa2PanelInfo() { return statsPanelInfo(oa2Port_(), oa2Adapter_()); }`.
 *
 * Собиралось это в каждом слоте руками — ровно так же, как руками копировался sidebar.html;
 * два новых поля шапки (`buckets`, `lastRun`) дописывать в трёх местах не нужно.
 * Пустая вкладка — не ошибка: панель открывают и до первого прогона.
 */
export function statsPanelInfo(
  port: SheetPort, adapter: StatsAdapter, profileName?: string | null, opts: TableOptions = {}
): PanelInfo {
  const built = adapter.buildConfig(profileName);
  const d = adapter.defaults || {};
  let saved: SavedParams | null = null;
  try { saved = statsReadParams(port, opts); } catch { saved = null; }
  return {
    profiles: built.profiles && built.profiles.length ? built.profiles : [built.profileName],
    modes: d.modes && d.modes.length ? d.modes : ['base'],
    defaultRounds: d.rounds || 100000,
    defaultShards: d.shards || 4,
    defaultSeed: d.seed || 0,
    configHash: statsConfigHash(adapter, built.config),
    buckets: (adapter.buckets ? adapter.buckets(built.config) : statBuckets()).length,
    lastRun: lastRunOf(port, opts),
    saved
  };
}
