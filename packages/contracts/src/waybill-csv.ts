export const WAYBILL_CSV_HEADER = ['订单号', '快递公司代码', '快递公司名称', '运单号'] as const;
export const WAYBILL_CSV_MAX_BYTES = 32768;
export interface WaybillCsvRow {
  row: number;
  orderNo: string;
  carrierCode: string;
  carrierName?: string;
  trackingNo: string;
}
// Strict UTF-8 CSV: quoted commas/double quotes supported, no ambiguous header mapping.
export function parseWaybillCsv(input: unknown): WaybillCsvRow[] {
  if (typeof input !== 'string' || new TextEncoder().encode(input).length > WAYBILL_CSV_MAX_BYTES)
    throw Error('请使用不超过32KB的UTF-8 CSV文件');
  const csv = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let cells: string[] = [],
    value = '',
    quoted = false,
    closed = false;
  const cell = () => {
    if (Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
      throw Error('CSV字段不允许换行或控制字符');
    cells.push(value.trim());
    value = '';
    closed = false;
  };
  const row = () => {
    cell();
    rows.push(cells);
    cells = [];
  };
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]!;
    if (quoted) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else value += c;
      continue;
    }
    if (c === '"') {
      if (value || closed) throw Error('CSV引号位置无效');
      quoted = true;
    } else if (c === ',') cell();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && csv[i + 1] === '\n') i++;
      row();
    } else {
      if (closed) throw Error('CSV引号后的内容无效');
      value += c;
    }
  }
  if (quoted) throw Error('CSV引号未闭合');
  if (value || cells.length || closed) row();
  while (rows.length && rows.at(-1)!.length === 1 && !rows.at(-1)![0]) rows.pop();
  if (JSON.stringify(rows.shift()) !== JSON.stringify(WAYBILL_CSV_HEADER))
    throw Error('表头必须为：订单号,快递公司代码,快递公司名称,运单号');
  if (rows.length < 1 || rows.length > 20) throw Error('每批请导入1至20笔订单');
  const seen = new Set<string>();
  return rows.map((r, i) => {
    if (r.length !== 4) throw Error(`第${i + 2}行列数或换行内容无效`);
    const orderNo = r[0]!.toUpperCase(),
      carrierCode = r[1]!.toUpperCase(),
      carrierName = r[2]!,
      trackingNo = r[3]!.toUpperCase();
    if (!/^R[A-F0-9]{32}$/.test(orderNo)) throw Error(`第${i + 2}行订单号无效，请使用原兑换订单号`);
    if (seen.has(orderNo)) throw Error(`第${i + 2}行订单重复`);
    seen.add(orderNo);
    return {
      row: i + 2,
      orderNo,
      carrierCode,
      ...(carrierName ? { carrierName } : {}),
      trackingNo,
    };
  });
}
export function waybillCsvTemplate(orderNos: string[] = []): string {
  const orders = orderNos.slice(0, 20);
  if (orders.some((n) => !/^R[A-F0-9]{32}$/.test(n))) throw Error('模板订单号无效');
  return (
    '\uFEFF' + WAYBILL_CSV_HEADER.join(',') + '\r\n' + orders.map((n) => n + ',,,\r\n').join('')
  );
}
