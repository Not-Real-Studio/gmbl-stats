// SheetPort: контракт транспорта. MemPort — эталон семантики, по нему сверяются GasPort/ApiPort:
// координаты 1-based, `size` — использованный прямоугольник, чтение за краем — пусто (не дырка),
// формулы хранятся строками и (при наличии вычислителя) читаются значениями.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemPort, portGrid } from '../src/index.ts';
import { sheetEvaluator } from './_sheet-eval.ts';

test('вкладки: ensureSheet создаёт, чтение неизвестной — громкая ошибка', () => {
  const port = new MemPort();
  assert.throws(() => port.size('stats'), /нет вкладки/);
  port.ensureSheet('stats');
  assert.deepEqual(port.size('stats'), { rows: 0, cols: 0 });
  assert.deepEqual(port.names(), ['stats']);
  port.ensureSheet('stats'); // идемпотентно
  assert.deepEqual(port.names(), ['stats']);
});

test('запись/чтение по 1-based координатам, за краем — пусто', () => {
  const port = new MemPort({ stats: [] });
  port.write('stats', 2, 3, [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(port.read('stats', 2, 3, 2, 2), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(port.read('stats', 1, 1, 1, 3), [['', '', '']]);
  assert.deepEqual(port.read('stats', 5, 5, 1, 2), [['', '']], 'за краем — пустые ячейки, не undefined');
  assert.deepEqual(port.size('stats'), { rows: 3, cols: 4 });
});

test('size — использованный прямоугольник; clear его обнуляет', () => {
  const port = new MemPort({ stats: [['a'], [], ['', 'b', '']] });
  assert.deepEqual(port.size('stats'), { rows: 3, cols: 2 });
  assert.deepEqual(portGrid(port, 'stats'), [['a', ''], ['', ''], ['', 'b']]);
  port.clear('stats');
  assert.deepEqual(port.size('stats'), { rows: 0, cols: 0 });
  assert.deepEqual(portGrid(port, 'stats'), []);
});

test('формулы: хранятся строкой, с вычислителем читаются значением (как в живом шите)', () => {
  const raw = new MemPort({ stats: [[2], [3], ['=SUM(A1:A2)']] });
  assert.equal(raw.read('stats', 3, 1, 1, 1)[0]?.[0], '=SUM(A1:A2)');

  const live = new MemPort({ stats: [[2], [3], ['=SUM(A1:A2)']] }, { evaluate: sheetEvaluator });
  assert.equal(live.read('stats', 3, 1, 1, 1)[0]?.[0], 5);
});

test('оформление копится по ячейкам и снимается снапшотом', () => {
  const port = new MemPort({ stats: [] });
  port.format('stats', 1, 1, 1, 2, { bold: true });
  port.format('stats', 1, 2, 1, 1, { bg: '#ffffff' });
  port.setColWidths('stats', 1, [100, 200]);
  assert.deepEqual(port.styleAt('stats', 1, 1), { bold: true });
  assert.deepEqual(port.styleAt('stats', 1, 2), { bold: true, bg: '#ffffff' }, 'стиль накапливается, а не затирается');
  const snap = port.snapshot('stats');
  assert.deepEqual(snap.widths, { '1': 100, '2': 200 });
  assert.deepEqual(Object.keys(snap.styles).sort(), ['1:1', '1:2']);
});

test('снапшот — копия: правка снимка не трогает порт', () => {
  const port = new MemPort({ stats: [['a']] });
  const snap = port.snapshot('stats');
  (snap.values[0] as unknown[])[0] = 'подмена';
  assert.equal(port.read('stats', 1, 1, 1, 1)[0]?.[0], 'a');
});

test('flush — граница батча, а не запись: считается, данные не меняет', () => {
  const port = new MemPort({ stats: [['a']] });
  port.flush();
  port.flush();
  assert.equal(port.flushes, 2);
  assert.deepEqual(portGrid(port, 'stats'), [['a']]);
});
