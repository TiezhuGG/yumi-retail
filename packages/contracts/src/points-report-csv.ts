import type { PointsReport, PointsReportKind } from './index.js';
export const POINTS_REPORT_KIND_LABELS: Record<PointsReportKind, string> = {
  GRANT: '积分发放',
  REDEEM: '商品兑换',
  CANCEL: '取消退回',
  RETURN: '售后退回',
  CORRECTION: '误发冲正',
};
const issueLabels = {
  MISSING: '缺少入账流水',
  INVALID: '金额或归属不符',
  UNEXPECTED: '业务未入账却有流水',
};
function text(v: string) {
  // Quote delimiters and neutralize spreadsheet formulas, including leading Unicode whitespace.
  const value =
    /^[=+\-@]/.test(v.trimStart()) ||
    Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      ? "'" + v
      : v;
  return '"' + value.replaceAll('"', '""') + '"';
}
function integer(v: string) {
  if (!/^-?\d+$/.test(v)) throw Error('Invalid integer points');
  return '"' + (v.replace('-', '').length > 15 ? "'" : '') + v + '"';
}
function stamp(v: string) {
  return new Date(Date.parse(v) + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}
export function pointsLedgerCsv(rows: PointsReport['items']): string {
  const header = [
    '入账时间（北京时间）',
    '业务类型',
    '业务依据',
    '顾客昵称',
    '应记积分',
    '实记积分',
    '核对结果',
    '业务关联键',
  ]
    .map(text)
    .join(',');
  return (
    '\uFEFF' +
    header +
    '\r\n' +
    rows
      .map(
        (r) =>
          [
            text(stamp(r.ledgerAt!)),
            text(POINTS_REPORT_KIND_LABELS[r.kind]),
            text(r.reference),
            text(r.displayName),
            integer(r.expectedPoints),
            integer(r.actualPoints!),
            text(r.issue ? issueLabels[r.issue] : '本次核对一致'),
            text(r.key),
          ].join(',') + '\r\n',
      )
      .join('')
  );
}
export function pointsDailyCsv(rows: PointsReport['daily']): string {
  return (
    '\uFEFF' +
    ['日期（北京时间）', '增加积分', '扣减积分', '净变动'].map(text).join(',') +
    '\r\n' +
    rows
      .map(
        (r) =>
          [text(r.date), integer(r.incoming), integer(r.outgoing), integer(r.net)].join(',') +
          '\r\n',
      )
      .join('')
  );
}
