import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWaybillCsv,
  waybillCsvTemplate,
  WAYBILL_CSV_HEADER,
} from '../packages/contracts/src/waybill-csv.ts';
const no = 'R' + 'A'.repeat(32),
  head = WAYBILL_CSV_HEADER.join(',');
test('UTF-8 BOM/CRLF and quoted commas/escaped quotes preserve literal carrier names', () => {
  const rows = parseWaybillCsv(
    '\uFEFF' + head + '\r\n' + no + ',other,"合成,快递""名称",ab-123456\r\n',
  );
  assert.deepEqual(rows, [
    {
      row: 2,
      orderNo: no,
      carrierCode: 'OTHER',
      carrierName: '合成,快递"名称',
      trackingNo: 'AB-123456',
    },
  ]);
});
test('strict CSV rejects bad columns/header/quote placement, multiline and formula order identities', () => {
  for (const csv of [
    '',
    head,
    head + '\n' + no + ',SF,',
    head + '\n' + no + ',SF,,SF123456,extra',
    head + '\n' + no + ',OTHER,"未闭合,SF123456',
    head + '\n' + no + ',OTHER,"公司"extra,SF123456',
    head + '\n' + no + ',OTHER,"\n公司",SF123456',
    head + '\n' + no + ',SF,\t,SF123456',
    '订单号,运单号\n' + no + ',SF123456',
    head + '\n=HYPERLINK("x"),SF,,SF123456',
  ])
    assert.throws(() => parseWaybillCsv(csv));
});
test('duplicates, oversized files and over-20 selections fail before any row can be used', () => {
  assert.throws(() =>
    parseWaybillCsv(head + '\n' + no + ',SF,,SF123456\n' + no.toLowerCase() + ',SF,,SF654321'),
  );
  assert.throws(() => parseWaybillCsv('a'.repeat(32769)));
  assert.throws(() =>
    parseWaybillCsv(
      head +
        '\n' +
        Array.from(
          { length: 21 },
          (_, i) => 'R' + i.toString(16).padStart(32, '0') + ',SF,,SF123456',
        ).join('\n'),
    ),
  );
});
test('templates use original order numbers, preserve text and do not insert fake waybills', () => {
  assert.equal(waybillCsvTemplate([no]), '\uFEFF' + head + '\r\n' + no + ',,,\r\n');
  assert.throws(() => waybillCsvTemplate(['=1+1']));
});
