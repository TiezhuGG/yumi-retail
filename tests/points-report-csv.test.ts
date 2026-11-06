import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PointsReport } from '../packages/contracts/src/index.ts';
import { pointsLedgerCsv, pointsDailyCsv } from '../packages/contracts/src/points-report-csv.ts';
const row: PointsReport['items'][number] = {
  key: 'GRANT:synthetic-key',
  kind: 'GRANT',
  sourceId: 'synthetic',
  reference: '  =SUM(1,2)',
  displayName: '+合成"昵称,测试',
  expectedPoints: '9007199254740993',
  actualPoints: '9007199254740993',
  occurredAt: '2026-01-01T00:00:00Z',
  ledgerAt: '2026-01-01T16:00:00Z',
  issue: null,
};
test('CSV quotes delimiters, neutralizes formula-like names/references and preserves long integer digits', () => {
  const csv = pointsLedgerCsv([row]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"2026-01-02 00:00:00"'));
  assert.ok(csv.includes('"\'  =SUM(1,2)"'));
  assert.ok(csv.includes('"\'+合成""昵称,测试"'));
  assert.ok(csv.includes('"\'9007199254740993"'));
  assert.ok(!csv.includes('9007199254740992'));
});
test('normal signed integer points stay numeric, unsafe text prefixes are protected and daily exports retain exact totals', () => {
  for (const value of [
    '=1+1',
    ' +1',
    '\t@formula',
    '\r-1',
    '\n=SUM(1)',
    '\u3000@value',
    '\u0000=1+1',
  ])
    assert.ok(
      pointsLedgerCsv([{ ...row, reference: value, actualPoints: '-240' }]).includes(
        '"\'' + value + '"',
      ),
    );
  const daily = pointsDailyCsv([
    { date: '2026-01-02', incoming: '360', outgoing: '250', net: '110' },
    { date: '2026-01-03', incoming: '0', outgoing: '240', net: '-240' },
  ]);
  assert.ok(daily.includes('"360","250","110"'));
  assert.ok(daily.includes('"0","240","-240"'));
  assert.throws(() =>
    pointsDailyCsv([{ date: '2026-01-01', incoming: '=1+1', outgoing: '0', net: '0' }]),
  );
});
test('empty exports contain only the complete header', () => {
  assert.equal(pointsLedgerCsv([]).split('\r\n').length, 2);
  assert.equal(pointsDailyCsv([]).split('\r\n').length, 2);
});
