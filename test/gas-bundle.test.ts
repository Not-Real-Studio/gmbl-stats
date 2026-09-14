// GAS-бандл обязан быть плоским файлом для Apps Script: ни import, ни export, ни module.exports —
// игра конкатенирует его в свой бандл. Публичные имена обязаны стать глобальными функциями,
// внутренние — не обязаны существовать вовсе (замыкание против коллизий с кодом игры).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { aggregateRows, rowsByLabel } from '../src/index.ts';
import { manifest, runShard } from './_fake-game.ts';

const cwd = fileURLToPath(new URL('..', import.meta.url));
execFileSync('node', ['build-gas.mjs'], { cwd });
const text = readFileSync(fileURLToPath(new URL('../dist/gm-stats.gas.js', import.meta.url)), 'utf8');

test('бандл плоский: ни import/export, ни module.exports, ни BigInt-литералов', () => {
  assert.equal(/^\s*(import|export)\s/m.test(text), false, 'в бандле остались import/export');
  assert.equal(text.includes('module.exports'), false, 'в бандле остался module.exports');
  const literals = text.match(/(?<![A-Za-z0-9_$])\d+n\b/g) ?? [];
  assert.deepEqual(literals, [], `в бандле BigInt-литералы: ${literals.join(', ')}`);
});

test('node-only слой в GAS-бандл не попадает: ни fs, ни сети', () => {
  assert.equal(text.includes('node:fs'), false, 'в бандле node:fs — ApiPort уехал в GAS');
  assert.equal(text.includes('sheets.googleapis.com'), false, 'в бандле REST-клиент Sheets API');
  assert.equal(text.includes('oauth2.googleapis.com'), false, 'в бандле OAuth-обмен токена');
});

test('бандл поднимает публичные имена глобальными (как в Apps Script)', () => {
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext(text, ctx);

  for (const name of ['statBuckets', 'statBucketLabel', 'statFineLabel', 'aggregateRows',
    'parseLadder', 'parseFine', 'makeBuckets', 'makeBucketsFromSpec',
    'rowsByLabel', 'mergeStats', 'baseStats', 'accumulateBase', 'configHash', 'manifestBuilder',
    'provenanceSection', 'rtpSection', 'histSection', 'fineSection', 'comboSection',
    'statsSkeleton', 'statsShardValues', 'statsAggregateFormulas', 'statsLocalizeFormula',
    'dashboardContent', 'distributionContent', 'comboContent', 'statsUpsertSummaryColumn',
    'statsPlanProfileActuals', 'STAT_LAYOUT', 'L_ROUNDS', 'L_RTP',
    'GasPort', 'MemPort', 'statsPrepareRun', 'statsComputeShard', 'statsWriteRun',
    'statsCommitSummary', 'statsWriteActuals', 'statsCheckStale', 'statsClearTab',
    'statsAggregateFromSheet', 'statsAssertHomogeneous', 'statsReadParams', 'statsSerialDate',
    'statsPanelHtml', 'statsPanelLimits', 'statsPanelInfo']) {
    assert.ok(ctx[name] !== undefined, `в бандле нет глобального имени «${name}»`);
  }
  assert.ok(ctx.GmStats, 'namespace GmStats тоже доступен');
});

test('бандл считает то же, что исходники (агрегат строка в строку)', () => {
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext(text, ctx);
  const columns = [runShard(400, 11), runShard(700, 12)].map((st) => manifest(st, {
    date: 46000, profile: 'rtp96', mode: 'base', seed: 11, config_hash: 'abcd1234', seconds: 1
  }));

  const bundled = (ctx.aggregateRows as typeof aggregateRows)(columns);
  const local = aggregateRows(columns);
  assert.equal(bundled.length, local.length);
  const a = rowsByLabel(bundled), b = rowsByLabel(local);
  for (const k of Object.keys(b)) assert.ok(Object.is(a[k], b[k]), `строка «${k}»: ${a[k]} ≠ ${b[k]}`);
});

test('панель в бандле генерит HTML под префикс слота (HtmlService получит готовую страницу)', () => {
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext(text, ctx);
  const html = (ctx.statsPanelHtml as (s: { title: string; prefix: string }) => string)(
    { title: 'SIM — Sample Slot', prefix: 'oa2' });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.ok(html.includes('.oa2ComputeShard('), 'в бандле панель не зовёт функции слота');
  assert.ok(html.includes('.oa2WriteRun('));
});

test('хэш конфига в бандле совпадает с хэшем в node (иначе инвалидация разъедется)', () => {
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext(text, ctx);
  const snapshot = { paytable: { A: { 3: 5 } }, weights: [1, 2, 3], flag: true };
  const gas = (ctx.configHash as (s: unknown) => string)(snapshot);
  assert.match(gas, /^[0-9a-f]{8}$/);
  assert.equal(gas, (ctx.configHash as (s: unknown) => string)({ ...snapshot }));
});
