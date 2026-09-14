// Панель прогона: тесты стерегут ОРКЕСТРАЦИЮ, а не вёрстку.
//
// Главный из них — «однописатель»: параллельные исполнения, пишущие один шит, теряют записи
// даже под локом (NOT-255, шапка table.ts). Это чинили дважды; третьего раза быть не должно,
// поэтому конструкция «считаем параллельно, пишем по одному» проверяется механически.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemPort, makeBucketsFromSpec, statBuckets, statsComputeShard, statsPanelHtml, statsPanelInfo,
  statsPanelLimits, statsPrepareRun, statsSerialDate, statsWriteRun
} from '../src/index.ts';
import { ADAPTER, adapterWithBuckets } from './_fake-game.ts';
import { sheetEvaluator } from './_sheet-eval.ts';
import { bootPanel, shardResult, writeResult } from './_panel-dom.ts';
import type { Panel } from './_panel-dom.ts';

const HTML = statsPanelHtml({
  title: 'SIM — Sample Slot',
  prefix: 'oa2',
  modesHint: 'base/ante — обычный раунд; buy* — бонус стартует сразу',
  defaults: { rounds: 100000, shards: 4, seed: 20260803 }
});

/** Панель с прогоном на старте: K колонок, `total` раундов итого, prepareRun уже отвечен. */
function started(shards: number, total: number, html = HTML): Panel {
  const panel = bootPanel(html);
  panel.set('shards', shards);
  panel.set('rounds', total);
  panel.exec('runAll()');
  const prepare = panel.inFlight('PrepareRun')[0];
  assert.ok(prepare, 'panel не позвала PrepareRun');
  prepare.ok({ rows: 120, shards, hash: 'abcd1234', profile: 'rtp96', mode: 'base' });
  return panel;
}

test('параллельность: 8 колонок стартуют разом, а не по одной', () => {
  const panel = started(8, 800000);
  assert.equal(panel.inFlight('ComputeShard').length, 8);
  assert.equal(panel.seen('ComputeShard').length, 8);
  assert.equal(panel.seen('WriteRun').length, 0, 'писать нечего — ни одна колонка не досчитана');
});

test('потолок: 50 колонок при maxShards 30 — в полёте не больше 30, стартуют все 50', () => {
  const html = statsPanelHtml({ title: 'SIM — sample-app', prefix: 'b2', maxShards: 30 });
  const panel = started(50, 20_000_000, html);

  assert.equal(panel.inFlight('ComputeShard').length, 30, 'пул не удержал потолок на старте');
  let peak = 30;
  for (let i = 0; i < 50; i++) {
    const call = panel.inFlight('ComputeShard')[0];
    assert.ok(call, 'колонка ' + (i + 1) + ' не стартовала');
    call.ok(shardResult(Number((call.args[0] as number)), 400000, 12));
    peak = Math.max(peak, panel.inFlight('ComputeShard').length);
    // Писатель не должен тормозить счёт: отвечаем ему сразу, как настоящий сервер.
    const w = panel.inFlight('WriteRun')[0];
    if (w) w.ok(writeResult((w.args[0] as unknown[]).length));
  }
  assert.equal(peak, 30, 'в полёте оказалось больше 30 исполнений: ' + peak);
  assert.equal(panel.seen('ComputeShard').length, 50, 'стартовали не все колонки');
  assert.equal(panel.inFlight('ComputeShard').length, 0);
});

test('однописатель: активен ровно один WriteRun, готовые колонки копятся в очередь (NOT-255)', () => {
  const panel = started(8, 800000);
  const computes = panel.inFlight('ComputeShard');

  computes[0]!.ok(shardResult(1));
  assert.equal(panel.inFlight('WriteRun').length, 1, 'первая колонка обязана уехать в запись сразу');

  // Пока запись висит, досчитываются остальные семь — второго WriteRun быть не может.
  for (let i = 1; i < 8; i++) {
    computes[i]!.ok(shardResult(i + 1));
    assert.ok(panel.inFlight('WriteRun').length <= 1,
      'параллельный WriteRun на колонке ' + (i + 1) + ' — записи потеряются');
  }
  assert.equal(panel.seen('WriteRun').length, 1, 'писателей стартовало больше одного');
  assert.equal(panel.exec('queue.length'), 7, 'досчитанные колонки обязаны копиться в очереди');

  const first = panel.inFlight('WriteRun')[0]!;
  assert.equal((first.args[0] as unknown[]).length, 1, 'первый батч — одна колонка');
  first.ok(writeResult(1));

  const second = panel.inFlight('WriteRun')[0];
  assert.ok(second, 'после освобождения писателя очередь обязана уехать');
  assert.equal((second.args[0] as unknown[]).length, 7, 'накопленное пишется одним батчем');
  assert.equal(panel.exec('queue.length'), 0);
  second.ok(writeResult(7));
  assert.equal(panel.seen('WriteRun').length, 2);
});

test('инкрементальность: первая пачка отдана до того, как досчитаны остальные', () => {
  const panel = started(8, 800000);
  panel.inFlight('ComputeShard')[0]!.ok(shardResult(1));

  const write = panel.inFlight('WriteRun')[0];
  assert.ok(write, 'запись не стартовала — прерванный прогон потеряет всё');
  assert.equal((write.args[0] as unknown[]).length, 1);
  assert.equal(panel.inFlight('ComputeShard').length, 7, 'остальные колонки ещё считаются');

  write.ok(writeResult(1));
  assert.match(panel.log()[0] as string, /записано \+1/);
});

test('прерывание: посчитанное записано, а не потеряно', () => {
  const panel = started(8, 800000);
  const computes = panel.inFlight('ComputeShard');
  for (let i = 0; i < 3; i++) {
    computes[i]!.ok(shardResult(i + 1));
    const w = panel.inFlight('WriteRun')[0];
    if (w) w.ok(writeResult((w.args[0] as unknown[]).length));
  }
  // Дальше прогон обрывается (панель закрыли) — оставшиеся пять исполнений не ответят никогда.
  const written = panel.seen('WriteRun')
    .flatMap((c) => c.args[0] as Array<{ shard: number }>)
    .map((r) => r.shard);
  assert.deepEqual(written.sort((a, b) => a - b), [1, 2, 3], 'посчитанные колонки не записаны');
  assert.equal(panel.exec('queue.length'), 0, 'в очереди осталось незаписанное');
  assert.equal(panel.inFlight('ComputeShard').length, 5);
});

test('ошибка колонки: остальные посчитаны и записаны, в логе видно какая', () => {
  const panel = started(8, 800000);
  const computes = panel.inFlight('ComputeShard');
  computes[3]!.fail('движок споткнулся');
  for (let i = 0; i < 8; i++) if (i !== 3) computes[i]!.ok(shardResult(i + 1));

  const write = panel.inFlight('WriteRun')[0]!;
  write.ok(writeResult((write.args[0] as unknown[]).length));
  const pass2 = panel.inFlight('WriteRun')[0];
  if (pass2) pass2.ok(writeResult((pass2.args[0] as unknown[]).length));

  const written = panel.seen('WriteRun').flatMap((c) => c.args[0] as Array<{ shard: number }>);
  assert.equal(written.length, 7, 'записаны не все уцелевшие колонки');
  assert.equal(written.some((r) => r.shard === 4), false, 'упавшая колонка попала в запись');
  assert.ok(panel.log().some((l) => /колонка 4 ОШИБКА: движок споткнулся/.test(l)));
  assert.equal(panel.el('s4').className, 's err');
  assert.ok(panel.log().some((l) => /Готово, ошибок счёта: 1/.test(l)));
});

test('ретраи записи: два провала, третья попытка проходит — очередь пуста', () => {
  const panel = started(4, 400000);
  const computes = panel.inFlight('ComputeShard');
  for (let i = 0; i < 4; i++) computes[i]!.ok(shardResult(i + 1));

  panel.inFlight('WriteRun')[0]!.fail('503 backend error');
  assert.equal(panel.exec('queue.length'), 4, 'батч обязан вернуться в очередь целиком');
  assert.equal(panel.inFlight('WriteRun').length, 0, 'ретрай не должен стартовать мимо таймера');
  panel.tick();

  panel.inFlight('WriteRun')[0]!.fail('503 backend error');
  panel.tick();

  const third = panel.inFlight('WriteRun')[0]!;
  third.ok(writeResult((third.args[0] as unknown[]).length));
  const last = panel.inFlight('WriteRun')[0];
  if (last) last.ok(writeResult((last.args[0] as unknown[]).length));

  const written = panel.seen('WriteRun')
    .filter((c) => c.done)
    .flatMap((c) => c.args[0] as Array<{ shard: number }>)
    .map((r) => r.shard);
  assert.deepEqual([...new Set(written)].sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.equal(panel.exec('queue.length'), 0);
  assert.equal(panel.exec('writing'), false);
  assert.ok(panel.log().some((l) => /попытка 1\/3, ретрай через 2с/.test(l)));
});

test('итого/на колонку: 20M × 50 → серверу rounds 400000; 20M × 1 → предупреждение, не запрет', () => {
  const panel = started(50, 20_000_000);
  const prepare = panel.seen('PrepareRun')[0]!;
  assert.equal((prepare.args[3] as { rounds: number }).rounds, 400000, 'prepareRun получил итого, а не на колонку');
  const compute = panel.seen('ComputeShard')[0]!;
  assert.equal((compute.args[1] as { rounds: number }).rounds, 400000);
  assert.equal((compute.args[1] as { shards: number }).shards, 50);

  const solo = bootPanel(HTML);
  solo.set('shards', 1);
  solo.set('rounds', 20_000_000);
  assert.equal(solo.el('run').disabled, false,
    'оценка не должна запрещать запуск — она строится на пробе и занижает скорость');
  assert.equal(solo.el('per').className, 'warn', 'превышение бюджета колонки не помечено');
  solo.exec('runAll()');
  assert.ok(solo.seen('PrepareRun').length > 0, 'предупреждение не должно мешать запуску');
  assert.ok(solo.log().some((l) => /Внимание/.test(l)), 'предупреждение не показано в логе');

  // Разложили на 50 колонок — предупреждение снято (прогон в этот момент ещё идёт).
  solo.set('shards', 50);
  assert.equal(solo.el('per').className, '', 'предупреждение осталось после дробления на колонки');
});

test('замер скорости: два прогона, накладные вычтены, оценка колонки пересчитана', () => {
  const panel = bootPanel(HTML);
  panel.set('shards', 10);
  panel.set('rounds', 1_000_000);
  panel.exec('probe()');

  // База за 1.1с и полная проба за 2.0с → скорость и накладные считаются из разницы.
  const small = panel.inFlight('ComputeShard')[0]!;
  assert.equal((small.args[1] as { rounds: number }).rounds, statsPanelLimits.probeBaseRounds);
  small.ok(shardResult(1, statsPanelLimits.probeBaseRounds, 1.1));
  const big = panel.inFlight('ComputeShard')[0]!;
  assert.equal((big.args[1] as { rounds: number }).rounds, statsPanelLimits.probeRounds);
  big.ok(shardResult(1, statsPanelLimits.probeRounds, 2.0));

  const expectSpeed = (statsPanelLimits.probeRounds - statsPanelLimits.probeBaseRounds) / (2.0 - 1.1);
  assert.equal(Math.round(panel.exec('speed') as number), Math.round(expectSpeed));
  assert.ok(Math.abs((panel.exec('overhead') as number) - 1) < 1e-9, 'накладные не вычтены');
  assert.match(String(panel.el('per').textContent), /на колонку: 100000 раундов ≈ \dс/);
  assert.equal(panel.el('run').disabled, false);

  // Медленный движок: колонка не укладывается в бюджет — панель обязана предупредить, но не запретить.
  const slow = bootPanel(HTML);
  slow.set('shards', 10);
  slow.set('rounds', 1_000_000);
  slow.exec('probe()');
  slow.inFlight('ComputeShard')[0]!.ok(shardResult(1, statsPanelLimits.probeBaseRounds, 11));
  slow.inFlight('ComputeShard')[0]!.ok(shardResult(1, statsPanelLimits.probeRounds, 1001));
  assert.equal(Math.round(slow.exec('speed') as number),
    Math.round((statsPanelLimits.probeRounds - statsPanelLimits.probeBaseRounds) / (1001 - 11)));
  assert.equal(slow.el('run').disabled, false, 'медленный замер предупреждает, но не запрещает');
  assert.equal(slow.el('per').className, 'warn');
  assert.match(String(slow.el('per').textContent), /оценка выше 300с/);
});

test('шапка состояния: бакеты, hash, колонки с протухшими', () => {
  const panel = bootPanel(HTML, { buckets: 42, configHash: 'deadbeef' });
  const stale = panel.seen('CheckStale')[0]!;
  assert.equal(stale.done, true);
  assert.match(String(panel.el('state').textContent), /бакетов в лестнице 42 · hash deadbeef/);
  assert.match(String(panel.el('state').textContent), /прогон 03\.08\.2026/);

  const dirty = bootPanel(HTML);   // bootPanel ответил нулём колонок — шапка про них молчит
  dirty.exec('checkStale()');
  dirty.inFlight('CheckStale')[0]!.ok({ ready: true, columns: 12, stale: 5, hash: 'abcd1234' });
  assert.match(String(dirty.el('state').textContent), /колонок 12, протухших 5/);
  assert.ok(dirty.log().some((l) => /ВНИМАНИЕ: протухших колонок 5 из 12/.test(l)));
});

test('statsPanelInfo: пустая вкладка — не ошибка, панель открывают и до прогона', () => {
  const port = new MemPort({ stats: [], statSummary: [], profiles: [] }, { evaluate: sheetEvaluator });
  const info = statsPanelInfo(port, ADAPTER);

  assert.deepEqual(info.profiles, ['rtp96', 'rtp94']);
  assert.deepEqual(info.modes, ['base']);
  assert.equal(info.defaultRounds, 500);
  assert.equal(info.defaultShards, 2);
  assert.equal(info.defaultSeed, 4242);
  assert.match(info.configHash, /^[0-9a-f]{8}$/);
  assert.equal(info.buckets, statBuckets().length, 'без своей лестницы — бакеты ядра');
  assert.equal(info.lastRun, '', 'прогона не было — дате взяться неоткуда');
  assert.equal(info.saved, null);
});

test('statsPanelInfo после прогона: сохранённые параметры, дата и своя лестница', () => {
  const bk = makeBucketsFromSpec('1,2,5,10,50,cap', { cap: 5000 });
  const adapter = adapterWithBuckets(bk);
  const port = new MemPort({ stats: [], statSummary: [], profiles: [] }, { evaluate: sheetEvaluator });
  const params = { profile: 'rtp94', mode: 'base', rounds: 300, seed: 7, shards: 2 };
  statsPrepareRun(port, adapter, params);
  const date = statsSerialDate(Date.UTC(2026, 7, 9, 12, 0, 0));
  const results = [1, 2].map((i) => {
    const r = statsComputeShard(adapter, i, params);
    for (const row of r.rows) if (row.label === 'date') row.value = date;
    return r;
  });
  statsWriteRun(port, adapter, results, params);

  const info = statsPanelInfo(port, adapter, 'rtp94');
  assert.equal(info.buckets, bk.buckets().length, 'витрина считает бакеты ИГРЫ, а не ядра');
  assert.deepEqual(info.saved, { profile: 'rtp94', mode: 'base', seed: 7, spins: 300, shards: 2 });
  assert.equal(info.lastRun, '09.08.2026');
  assert.equal(info.configHash, statsPanelInfo(port, adapter, 'rtp94').configHash);
});

test('снимок HTML: вызовы префикса слота и ничего чужого', () => {
  assert.match(HTML, /oa2ComputeShard\(i, params\(\)\)/);
  for (const fn of ['PanelInfo', 'PrepareRun', 'ComputeShard', 'WriteRun', 'CommitSummary',
    'WriteActuals', 'CheckStale', 'ClearStats']) {
    assert.ok(HTML.includes('.oa2' + fn + '('), 'панель не зовёт oa2' + fn);
  }
  // Ни чужого префикса, ни серверных имён ядра: панель зовёт функции СЛОТА.
  assert.equal(/\bsample-slot[A-Z]/.test(HTML), false, 'в HTML остался префикс другого слота');
  assert.equal(/\.stats[A-Z]\w*\(/.test(HTML), false, 'панель зовёт функции ядра напрямую');
  assert.equal(HTML.includes('LockService'), false, 'LockService в панели — запрещённое «решение» гонки');

  // Список серверных вызовов закрыт: ровно восемь имён эталона, ни одного сверх.
  const names = new Set((HTML.match(/\.oa2[A-Za-z]+\(/g) || []).map((s) => s.slice(1, -1)));
  assert.equal(names.size, 8, 'состав серверных функций разъехался: ' + [...names].join(', '));

  assert.ok(HTML.includes('<h3>SIM — Sample Slot</h3>'));
  assert.ok(HTML.includes('Итого раундов'));
  assert.equal(statsPanelHtml({ title: 'x', prefix: 'b2' }).includes('.b2ComputeShard('), true);
  assert.throws(() => statsPanelHtml({ title: 'x', prefix: 'a-b' }), /не идентификатор JS/);
});
