// ApiPort: Sheets API v4 прямым fetch. Живой документ здесь не нужен — проверяется контракт,
// который и ломается тихо: что именно уезжает в API (диапазоны, USER_ENTERED, порядок операций,
// число запросов) и что порт делает без сети (кэш, буфер, громкая ошибка на незагруженную вкладку).
//
// Сквозная проверка против настоящего документа — отдельный E2E-скрипт игры (он требует кредов).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiPort } from '../src/api-port.ts';
import type { FetchLike } from '../src/api-port.ts';

interface Call { url: string; method: string; body: Record<string, unknown> | null }

function stub(responses: Array<{ status?: number; json: unknown }>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url, method: (init && init.method) || 'GET',
      body: init && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return { status: (r && r.status) || 200, json: async () => (r ? r.json : {}) };
  };
  return { fetch: fetchImpl, calls };
}

const META = { json: { sheets: [{ properties: { sheetId: 77, title: 'stats' } }] } };
const VALUES = (values: unknown[][]): { json: unknown } => ({ json: { valueRanges: [{ values }] } });

function port(responses: Array<{ status?: number; json: unknown }>): { p: ApiPort; calls: Call[] } {
  const s = stub(responses);
  return { p: new ApiPort('DOC', { token: 'tok', fetchImpl: s.fetch, retryDelays: [1, 1] }), calls: s.calls };
}

test('load: метаданные + значения одним batchGet, вычисленными числами', async () => {
  const { p, calls } = port([META, VALUES([['label', 1], ['RTP % total', 96.5]])]);
  await p.load(['stats']);
  assert.equal(calls.length, 2);
  assert.match(calls[0]?.url ?? '', /\/DOC\?fields=sheets\.properties/);
  assert.match(calls[1]?.url ?? '', /values:batchGet\?ranges='stats'&valueRenderOption=UNFORMATTED_VALUE/);
  assert.deepEqual(p.size('stats'), { rows: 2, cols: 2 });
  assert.deepEqual(p.read('stats', 2, 1, 1, 2), [['RTP % total', 96.5]]);
  assert.deepEqual(p.read('stats', 9, 9, 1, 1), [['']], 'за краем — пусто');
});

test('чтение незагруженной вкладки — громкая ошибка со ссылкой на load()', () => {
  const { p } = port([META]);
  assert.throws(() => p.read('stats', 1, 1, 1, 1), /не загружена/);
});

test('запись копится в буфер, кэш обновляется сразу, commit шлёт USER_ENTERED', async () => {
  const { p, calls } = port([META, VALUES([['x']]), { json: {} }]);
  await p.load(['stats']);
  p.write('stats', 3, 2, [['a', '=SUM(D3:F3)']]);
  assert.equal(p.pending(), 1);
  assert.deepEqual(p.read('stats', 3, 2, 1, 2), [['a', '=SUM(D3:F3)']], 'свои записи видны до отправки');
  p.flush();
  assert.equal(calls.length, 2, 'flush — граница батча, а не запрос');

  const res = await p.commit();
  assert.deepEqual(res, { requests: 1, ops: 1 });
  const body = calls[2]?.body as { valueInputOption: string; data: Array<{ range: string; values: unknown[][] }> };
  assert.equal(calls[2]?.method, 'POST');
  assert.match(calls[2]?.url ?? '', /values:batchUpdate/);
  assert.equal(body.valueInputOption, 'USER_ENTERED', 'формулы обязаны остаться формулами');
  assert.equal(body.data[0]?.range, "'stats'!B3:C3");
  assert.deepEqual(body.data[0]?.values, [['a', '=SUM(D3:F3)']]);
  assert.equal(p.pending(), 0);
});

test('порядок операций сохраняется, однотипные склеиваются: clear → values → requests', async () => {
  const { p, calls } = port([META, VALUES([['x']]), { json: {} }, { json: {} }, { json: {} }]);
  await p.load(['stats']);
  p.clear('stats');
  p.write('stats', 1, 1, [['a']]);
  p.write('stats', 2, 1, [['b']]);
  p.format('stats', 1, 1, 1, 1, { bold: true, bg: '#f1f3f4' });
  p.setColWidths('stats', 1, [260]);
  const res = await p.commit();
  assert.deepEqual(res, { requests: 3, ops: 5 }, 'три запроса вместо пяти — квота ~60/мин');
  assert.match(calls[2]?.url ?? '', /values:batchClear/);
  assert.match(calls[3]?.url ?? '', /values:batchUpdate/);
  assert.match(calls[4]?.url ?? '', /DOC:batchUpdate/);
  const data = (calls[3]?.body as { data: Array<{ range: string }> }).data;
  assert.deepEqual(data.map((d) => d.range), ["'stats'!A1:A1", "'stats'!A2:A2"]);
});

test('форматирование: repeatCell с маской полей и sheetId, ширины — updateDimensionProperties', async () => {
  const { p, calls } = port([META, VALUES([['x']]), { json: {} }]);
  await p.load(['stats']);
  p.format('stats', 2, 3, 1, 4, { bold: true, bg: '#ffffff', fontColor: '#999999', numberFormat: 'dd.MM.yyyy' });
  p.setColWidths('stats', 2, [320]);
  await p.commit();
  const reqs = (calls[2]?.body as { requests: Array<Record<string, any>> }).requests;
  const cell = reqs[0]?.['repeatCell'];
  assert.deepEqual(cell.range, {
    sheetId: 77, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 2, endColumnIndex: 6
  });
  assert.deepEqual(cell.cell.userEnteredFormat.backgroundColor, { red: 1, green: 1, blue: 1 });
  assert.equal(cell.cell.userEnteredFormat.textFormat.bold, true);
  assert.deepEqual(cell.cell.userEnteredFormat.numberFormat, { type: 'DATE', pattern: 'dd.MM.yyyy' });
  assert.deepEqual(String(cell.fields).split(','), [
    'userEnteredFormat.backgroundColor', 'userEnteredFormat.textFormat.foregroundColor',
    'userEnteredFormat.textFormat.bold', 'userEnteredFormat.numberFormat'
  ]);
  assert.equal(reqs[1]?.['updateDimensionProperties'].properties.pixelSize, 320);
  assert.deepEqual(reqs[1]?.['updateDimensionProperties'].range,
    { sheetId: 77, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 });
});

test('форматирование неизвестной вкладки — громкая ошибка (sheetId неоткуда взять)', async () => {
  const { p } = port([META, VALUES([['x']])]);
  await p.load(['stats']);
  p.ensureSheet('свежая');
  assert.throws(() => p.format('свежая', 1, 1, 1, 1, { bold: true }), /нет sheetId/);
});

test('ensureSheet: отсутствующая вкладка заводится addSheet-запросом, повтор не дублирует', async () => {
  const { p, calls } = port([META, VALUES([['x']]), { json: {} }, META]);
  await p.load(['stats']);
  p.ensureSheet('statSummary');
  p.ensureSheet('statSummary');
  assert.equal(p.pending(), 1);
  await p.commit();
  const reqs = (calls[2]?.body as { requests: Array<Record<string, unknown>> }).requests;
  assert.deepEqual(reqs, [{ addSheet: { properties: { title: 'statSummary' } } }]);
  assert.match(calls[3]?.url ?? '', /fields=sheets\.properties/, 'после addSheet метаданные перечитаны');
});

test('429 — бэкофф и повтор, не падение', async () => {
  const s = stub([
    META, VALUES([['x']]),
    { status: 429, json: { error: { code: 429, message: 'Quota exceeded' } } },
    { json: {} }
  ]);
  const p = new ApiPort('DOC', { token: 'tok', fetchImpl: s.fetch, retryDelays: [1, 1] });
  await p.load(['stats']);
  p.write('stats', 1, 1, [['a']]);
  await p.commit();
  assert.equal(s.calls.length, 4, 'один повтор после 429');
});

test('ошибка API — громкая, с методом и путём', async () => {
  const { p } = port([META, VALUES([['x']]), { status: 400, json: { error: { code: 400, message: 'Bad range' } } }]);
  await p.load(['stats']);
  p.write('stats', 1, 1, [['a']]);
  await assert.rejects(() => p.commit(), /Sheets API \(POST \/DOC\/values:batchUpdate\): Bad range/);
});

test('reload перечитывает загруженные вкладки (формулы отдают числа только после круга по сети)', async () => {
  const { p, calls } = port([META, VALUES([['=SUM(A2:A3)']]), VALUES([[42]])]);
  await p.load(['stats']);
  await p.reload();
  assert.equal(calls.length, 3);
  assert.equal(p.read('stats', 1, 1, 1, 1)[0]?.[0], 42);
});
