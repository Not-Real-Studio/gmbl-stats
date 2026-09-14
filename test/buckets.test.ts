// Словари распределений — снапшот лейблов. Лейбл бакета попадает в лейбл строки манифеста,
// а строки манифеста адресуют сохранённые колонки statSummary: молчаливая правка словаря
// разъезжает архив всех прогонов.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BUCKETS, STAT_FINE_MAX, STAT_FINE_STEP, STAT_LADDER, makeBuckets, makeBucketsFromSpec,
  parseFine, parseLadder, statBucketLabel, statBuckets, statFineLabel, statFineLabels
} from '../src/index.ts';

const EXPECTED = ['0x', '(0,1)x', '[1,2)x', '[2,5)x', '[5,10)x', '[10,20)x', '[20,50)x',
  '[50,75)x', '[75,100)x', '[100,125)x', '[125,150)x', '[150,200)x', '[200,250)x', '[250,300)x',
  '[300,400)x', '[400,500)x', '[500,600)x', '[600,700)x', '[700,800)x', '[800,1000)x',
  '[1000,1500)x', '[1500,2000)x', '[2000,+)x'];

test('бакеты стандартной лестницы: снапшот лейблов', () => {
  assert.deepEqual(statBuckets().map((b) => b.label), EXPECTED);
  assert.equal(statBuckets().length, STAT_LADDER.length + 2);
});

test('bucketLabel: границы включительно снизу, исключительно сверху; ноль отдельным бакетом', () => {
  assert.equal(statBucketLabel(0), '0x');
  assert.equal(statBucketLabel(-5), '0x');
  assert.equal(statBucketLabel(0.0001), '(0,1)x');
  assert.equal(statBucketLabel(0.999), '(0,1)x');
  assert.equal(statBucketLabel(1), '[1,2)x');
  assert.equal(statBucketLabel(1.999), '[1,2)x');
  assert.equal(statBucketLabel(2), '[2,5)x');
  assert.equal(statBucketLabel(1999.9), '[1500,2000)x');
  assert.equal(statBucketLabel(2000), '[2000,+)x');
  assert.equal(statBucketLabel(1e9), '[2000,+)x');
});

test('fine grid: шаг 50 до 3000+, снапшот краёв', () => {
  const fine = statFineLabels();
  assert.equal(fine.length, STAT_FINE_MAX / STAT_FINE_STEP + 1);
  assert.equal(fine[0], '0-50');
  assert.equal(fine[1], '50-100');
  assert.equal(fine[fine.length - 2], '2950-3000');
  assert.equal(fine[fine.length - 1], '3000+');
  assert.equal(statFineLabel(0), '0-50');
  assert.equal(statFineLabel(49.99), '0-50');
  assert.equal(statFineLabel(50), '50-100');
  assert.equal(statFineLabel(2999), '2950-3000');
  assert.equal(statFineLabel(3000), '3000+');
  assert.equal(statFineLabel(99999), '3000+');
});

test('каждый лейбл fine grid — свой (иначе строки манифеста схлопнутся)', () => {
  const fine = statFineLabels();
  assert.equal(new Set(fine).size, fine.length);
  const b = statBuckets().map((x) => x.label);
  assert.equal(new Set(b).size, b.length);
});

test('makeBuckets: своя лестница и свой fine grid', () => {
  const b = makeBuckets([1, 10, 100], 25, 100);
  assert.deepEqual(b.buckets().map((x) => x.label), ['0x', '(0,1)x', '[1,10)x', '[10,100)x', '[100,+)x']);
  assert.equal(b.bucketLabel(50), '[10,100)x');
  assert.equal(b.bucketLabel(1000), '[100,+)x');
  assert.deepEqual(b.fineLabels(), ['0-25', '25-50', '50-75', '75-100', '100+']);
  assert.equal(b.fineLabel(80), '75-100');
  assert.equal(b.fineLabel(100), '100+');
  // дефолт не задет
  assert.deepEqual(statBuckets().map((x) => x.label), EXPECTED);
});

test('buckets() отдаёт копию: правка вызывающего не портит словарь', () => {
  const first = DEFAULT_BUCKETS.buckets();
  first.length = 1;
  assert.equal(DEFAULT_BUCKETS.buckets().length, EXPECTED.length);
});

// --- DSL лестницы ---------------------------------------------------------------------------

/** Новая сетка sample-app: шаг 10 между 20x и 100x под калибровку биг-вина + кап. */
const sample-app_SPEC = '1,2,5,10,20..100:10,125,150,200,250,300,400,500,600,700,800,1000,1500,2000,' +
  '2500,3000,4000,5000,10000,20000,cap';

test('parseLadder: плоский список границ', () => {
  assert.deepEqual(parseLadder('1,2,5,10'), { ladder: [1, 2, 5, 10], hasCap: false });
  assert.deepEqual(parseLadder(' 1 , 2 ,5, 10 ').ladder, [1, 2, 5, 10], 'пробелы игнорируются');
});

test('parseLadder: сегмент a..b:s разворачивается включительно с обеих сторон', () => {
  const { ladder } = parseLadder('10..100:10');
  assert.deepEqual(ladder, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(ladder.length, 10);
  assert.deepEqual(parseLadder('0.1..0.5:0.1').ladder, [0.1, 0.2, 0.3, 0.4, 0.5],
    'дробный шаг не копит ошибку float в лейблах');
});

test('parseLadder: новая сетка sample-app целиком', () => {
  const { ladder, hasCap } = parseLadder(sample-app_SPEC);
  assert.equal(hasCap, true);
  assert.equal(ladder.length, 32);
  for (const b of [30, 60, 90, 100, 20000]) assert.ok(ladder.includes(b), 'нет границы ' + b);
  assert.ok(!ladder.includes(110), 'шаг 10 кончается на 100');
  assert.ok(!ladder.includes(75), 'старой границы 75 в новой сетке нет');
  for (let i = 1; i < ladder.length; i++) {
    assert.ok((ladder[i] as number) > (ladder[i - 1] as number), 'границы строго возрастают');
  }
});

test('parseLadder: ошибки — каждая своим сообщением, молча ронять хвост нельзя', () => {
  assert.throws(() => parseLadder('20..95:10'), /не делит/);
  assert.throws(() => parseLadder('5..1:1'), /≤ начала/);
  assert.throws(() => parseLadder('10..20:0'), /шаг обязан быть > 0/);
  assert.throws(() => parseLadder('10..20'), /без шага/);
  assert.throws(() => parseLadder('1,5,3'), /не возрастают/);
  assert.throws(() => parseLadder('100,100..200:25'), /дубль границы/);
  assert.throws(() => parseLadder('cap,100'), /только последним/);
  assert.throws(() => parseLadder('0,1,2'), /≤ 0/);
  assert.throws(() => parseLadder('1,-2'), /≤ 0/);
  assert.throws(() => parseLadder('1,два,5'), /не число/);
  assert.throws(() => parseLadder('1,,5'), /пустой токен/);
  assert.throws(() => parseLadder('cap'), /ни одной границы/);
});

test('parseLadder: пустая строка — стандартная лестница (поведение по умолчанию)', () => {
  assert.deepEqual(parseLadder(''), { ladder: STAT_LADDER.slice(), hasCap: false });
  assert.deepEqual(parseLadder('   ').ladder, STAT_LADDER.slice());
});

test('parseFine: step/max', () => {
  assert.deepEqual(parseFine('50/3000'), { fineStep: 50, fineMax: 3000 });
  assert.deepEqual(parseFine(' 25 / 100 '), { fineStep: 25, fineMax: 100 });
  assert.deepEqual(parseFine(''), { fineStep: STAT_FINE_STEP, fineMax: STAT_FINE_MAX });
  assert.throws(() => parseFine('50'), /формат step\/max/);
  assert.throws(() => parseFine('50/3000/2'), /формат step\/max/);
  assert.throws(() => parseFine('мусор/3000'), /шаг/);
  assert.throws(() => parseFine('50/'), /максимум/);
  assert.throws(() => parseFine('0/3000'), /шаг/);
  assert.throws(() => parseFine('7/3000'), /не делится/);
});

test('лейблы дефолтной лестницы через DSL — те же, что у makeBuckets()', () => {
  const spec = STAT_LADDER.join(',');
  assert.deepEqual(makeBucketsFromSpec(spec).buckets(), makeBuckets().buckets());
  assert.deepEqual(makeBucketsFromSpec('').buckets().map((b) => b.label), EXPECTED);
});

test('голова считается от первой границы лестницы, а не от единицы', () => {
  const b = makeBucketsFromSpec('5,10,20');
  assert.deepEqual(b.buckets().map((x) => x.label),
    ['0x', '(0,5)x', '[5,10)x', '[10,20)x', '[20,+)x']);
  assert.equal(b.bucketLabel(4.99), '(0,5)x');
  assert.equal(b.bucketLabel(5), '[5,10)x');
});

// --- Бакеты капа ----------------------------------------------------------------------------

test('cap: хвост — [last,C)x, точечный Cx и >Cx', () => {
  const b = makeBucketsFromSpec(sample-app_SPEC, { cap: 25000 });
  assert.equal(b.cap, 25000);
  const labels = b.buckets().map((x) => x.label);
  assert.deepEqual(labels.slice(-3), ['[20000,25000)x', '25000x', '>25000x']);
  assert.equal(labels[0], '0x');
  assert.equal(labels[1], '(0,1)x');
  assert.equal(new Set(labels).size, labels.length, 'каждый лейбл свой');

  const exact = b.buckets().filter((x) => x.exact);
  assert.equal(exact.length, 1);
  assert.deepEqual({ lo: exact[0]?.lo, hi: exact[0]?.hi }, { lo: 25000, hi: 25000 });
});

test('cap: попадание в кап ловится с допуском, а не побитовым равенством', () => {
  const b = makeBucketsFromSpec(sample-app_SPEC, { cap: 25000 });
  assert.equal(b.bucketLabel(24999.9), '[20000,25000)x');
  assert.equal(b.bucketLabel(25000), '25000x');
  assert.equal(b.bucketLabel(25000.0000001), '25000x');
  assert.equal(b.bucketLabel(24999.9999999), '25000x');
  assert.equal(b.bucketLabel(25001), '>25000x');
  assert.equal(b.bucketLabel(1e9), '>25000x');
  assert.equal(b.bucketLabel(0), '0x');
  assert.equal(b.bucketLabel(95), '[90,100)x', 'середина новой сетки со шагом 10');
});

test('cap: строка просит cap — игра обязана его передать', () => {
  assert.throws(() => makeBucketsFromSpec(sample-app_SPEC), /лестница просит cap/);
  assert.throws(() => makeBucketsFromSpec('1,2,5,cap', { cap: null }), /лестница просит cap/);
  // cap без маркера в строке — игнорируется
  assert.deepEqual(makeBucketsFromSpec('1,2,5', { cap: 25000 }).buckets().map((x) => x.label),
    ['0x', '(0,1)x', '[1,2)x', '[2,5)x', '[5,+)x']);
});

test('cap на последней границе лестницы даёт пустой интервал — throw', () => {
  assert.throws(() => makeBucketsFromSpec('1,2,25000,cap', { cap: 25000 }), /пуст/);
  assert.throws(() => makeBuckets([1, 2, 5], 50, 3000, 5), /пуст/);
  assert.throws(() => makeBuckets([1, 2, 5], 50, 3000, 0), /> 0/);
});

test('makeBucketsFromSpec: свой fine grid строкой', () => {
  const b = makeBucketsFromSpec('1,2,5', { fine: '25/100' });
  assert.deepEqual(b.fineLabels(), ['0-25', '25-50', '50-75', '75-100', '100+']);
  assert.equal(b.fineStep, 25);
  assert.equal(b.fineMax, 100);
});
