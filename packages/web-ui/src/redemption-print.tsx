import { useEffect, useRef, useState } from 'react';
import type { RedemptionPrintPreview, StaffProfile } from '@yumi/contracts';
import { formatRedemptionAddress } from '@yumi/contracts';
import { staffRequest } from './index.js';

// Only validated server snapshots are rendered. Customer data is always text, never markup.
function renderSheets(frame: HTMLIFrameElement, preview: RedemptionPrintPreview) {
  const d = frame.contentDocument;
  if (!d) throw Error('打印页面未就绪，请重试');
  d.documentElement.lang = 'zh-CN';
  d.title = '积分兑换订单配货单';
  const style = d.createElement('style');
  style.textContent = `
 *{box-sizing:border-box}body{margin:0;padding:20px;background:#f6f6ef;font-family:Arial,"Microsoft YaHei",sans-serif;color:#23251f;font-size:14px;line-height:1.65}.sheet{background:white;max-width:760px;padding:30px;margin:0 auto 20px;border:1px solid #e8e8e0;border-radius:12px;overflow-wrap:anywhere}.brand{color:#282c23;letter-spacing:2px;font-weight:bold}h1{font-size:24px;margin:8px 0}h2{font-size:16px;margin:22px 0 8px}p{margin:8px 0}.meta{color:#62665a}.recipient{border:1px solid #e8e8e0;padding:16px;border-radius:8px}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{padding:10px 8px;text-align:left;border-bottom:1px solid #e8e8e0}th{background:#f5f6ef}.total{text-align:right;font-weight:bold;font-size:17px}.foot{margin-top:24px;padding-top:12px;border-top:1px solid #e8e8e0;color:#62665a;font-size:12px}tr{break-inside:avoid}@page{size:A4 portrait;margin:14mm}@media print{body{padding:0;background:white;color:#111}.sheet{max-width:none;padding:0;margin:0;border:0;border-radius:0;break-after:page;page-break-after:always}.sheet:last-child{break-after:auto;page-break-after:auto}.brand{color:#111}th{background:white}.recipient{break-inside:avoid}}@media screen and (max-width:500px){body{padding:8px}.sheet{padding:16px}th,td{padding:8px 3px;font-size:12px}th{white-space:nowrap}}
 `;
  d.head.replaceChildren(style);
  d.body.replaceChildren();
  const node = (tag: string, text?: string, cls?: string) => {
    const el = d.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  const stamp = (value: string) =>
    new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  let combined: HTMLElement | undefined;
  if (preview.consolidatedLines) {
    combined = node('article', undefined, 'sheet');
    combined.append(node('div', '玉米百货 · 社区好生活', 'brand'), node('h1', '多订单汇总配货单'));
    const a = preview.items[0]!.address;
    combined.append(
      node('p', a.contactName + ' · ' + a.phone),
      node('p', formatRedemptionAddress(a)),
    );
    if (a.note) combined.append(node('p', '地址备注：' + a.note));
    combined.append(
      node(
        'p',
        `共 ${preview.items.length} 单 · 商家承担运费 · ` +
          (preview.items[0]!.executionMode === 'PRODUCTION'
            ? '生产订单'
            : preview.items[0]!.executionMode === 'CONTROLLED'
              ? '受控测试订单'
              : '本地开发订单'),
      ),
    );
    const table = node('table'),
      head = node('thead'),
      hr = node('tr'),
      body = node('tbody');
    for (const x of ['商品 / 规格', '配货数量']) hr.append(node('th', x));
    head.append(hr);
    for (const line of preview.consolidatedLines) {
      const row = node('tr');
      row.append(
        node('td', line.title + ' · ' + line.spec),
        node('td', line.quantity + ' ' + line.unit),
      );
      body.append(row);
    }
    table.append(head, body);
    combined.append(
      table,
      node(
        'p',
        '总计：' +
          preview.items.reduce((n, o) => n + BigInt(o.totalPoints), 0n).toString() +
          ' 积分',
        'total',
      ),
      node('h2', '原订单明细'),
    );
    d.body.append(combined);
  }
  for (const o of preview.items) {
    const sheet = node('article', undefined, combined ? 'order-detail' : 'sheet');
    if (!combined)
      sheet.append(
        node('div', '玉米百货 · 社区好生活', 'brand'),
        node('h1', '积分兑换订单配货单'),
        node('p', '兑换单号：' + o.orderNo),
        node(
          'p',
          o.executionMode === 'CONTROLLED'
            ? '受控测试订单'
            : o.executionMode === 'PRODUCTION'
              ? '积分快递订单'
              : '本地开发订单',
        ),
        node('p', '下单时间：' + stamp(o.createdAt) + '（北京时间）', 'meta'),
        node(
          'p',
          '订单状态：有效兑换 · 配送方式：' +
            (o.deliveryMode === 'EXPRESS' ? '快递发货 · 商家承担运费' : '小区配送（原流程）'),
          'meta',
        ),
      );
    if (o.expressShipment)
      sheet.append(
        node(
          'p',
          '已快递发货：' +
            o.expressShipment.carrierName +
            ' · 运单号：' +
            o.expressShipment.trackingNo +
            (o.expressShipment.correctedAt ? '（运单资料已更正）' : ''),
        ),
      );
    const recipient = node('section', undefined, 'recipient');
    recipient.append(
      node('h2', '收件信息'),
      node('p', o.address.contactName + ' · ' + o.address.phone),
      node('p', formatRedemptionAddress(o.address)),
    );
    if (o.address.note) recipient.append(node('p', '地址备注：' + o.address.note));
    if (o.address.orderNote) recipient.append(node('p', '订单备注：' + o.address.orderNote));
    if (!combined) sheet.append(recipient);
    else {
      sheet.append(
        node('h2', '订单：' + o.orderNo),
        node('p', '下单时间：' + stamp(o.createdAt), 'meta'),
      );
      if (o.address.orderNote) sheet.append(node('p', '订单备注：' + o.address.orderNote));
    }
    const table = node('table'),
      head = node('thead'),
      hr = node('tr');
    for (const x of ['商品 / 规格', '数量', '单件积分', '合计积分']) hr.append(node('th', x));
    head.append(hr);
    const body = node('tbody'),
      row = node('tr');
    for (const x of [
      o.title + ' · ' + o.spec,
      o.quantity + ' ' + o.unit,
      o.pointsPrice,
      o.totalPoints,
    ])
      row.append(node('td', x));
    body.append(row);
    table.append(head, body);
    sheet.append(table, node('p', '合计：' + o.totalPoints + ' 积分', 'total'));
    if (!combined)
      sheet.append(
        node('p', '核对人：________________    核对日期：________________'),
        node(
          'p',
          '本单为订单配货单，非快递电子面单。打印不代表已发货，发货状态以系统记录为准。',
          'foot',
        ),
        node('p', '预览生成时间：' + stamp(preview.generatedAt) + '（北京时间）', 'meta'),
      );
    if (combined) combined.append(sheet);
    else d.body.append(sheet);
  }
  if (combined)
    combined.append(
      node('p', '核对人：________________    核对日期：________________'),
      node(
        'p',
        '仅汇总配货，尚未确认合包或统一运单发货。本单非快递电子面单。请按原订单核对；打印不改变库存、积分或订单状态。',
        'foot',
      ),
      node('p', '预览生成时间：' + stamp(preview.generatedAt) + '（北京时间）', 'meta'),
    );
}
export function RedemptionPrintDialog({
  ids,
  consolidated = false,
  profile,
  onClose,
}: {
  ids: string[];
  consolidated?: boolean;
  profile: StaffProfile;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<RedemptionPrintPreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null),
    frame = useRef<HTMLIFrameElement>(null),
    seq = useRef(0),
    working = useRef(false);
  async function load(print = false) {
    if (working.current) return;
    working.current = true;
    const n = ++seq.current;
    setBusy(true);
    setError('');
    setPreview(null);
    if (frame.current?.contentDocument) frame.current.contentDocument.body.replaceChildren();
    try {
      const result = await staffRequest<RedemptionPrintPreview>(
        consolidated
          ? '/admin/redemptions/consolidated-print-preview'
          : '/admin/redemptions/print-preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
          body: JSON.stringify({ ids }),
        },
      );
      if (n !== seq.current) return;
      if (!frame.current) throw Error('打印预览未就绪，请重试');
      renderSheets(frame.current, result);
      setPreview(result);
      if (print) {
        frame.current.contentWindow?.focus();
        frame.current.contentWindow?.print();
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '打印资料读取失败');
    } finally {
      if (n === seq.current) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    dialog.current?.showModal();
    void load();
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      seq.current++;
      working.current = false;
      document.body.style.overflow = old;
    };
  }, []);
  const close = () => {
    seq.current++;
    setPreview(null);
    onClose();
  };
  return (
    <dialog
      ref={dialog}
      className="redemption-print-overlay"
      aria-label="订单打印预览"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="redemption-print-window">
        <div className="redemption-print-toolbar">
          <div>
            <h2>{consolidated ? '汇总配货打印预览' : '订单打印预览'}</h2>
            <p>
              已选择 {ids.length} 单 · {consolidated ? 'A4 汇总配货' : 'A4 每单分页'} ·
              打印不改变发货状态
            </p>
          </div>
          <div>
            <button className="secondary-button" onClick={close} autoFocus>
              关闭打印预览
            </button>
            <button
              className="primary-button"
              disabled={busy || !preview}
              onClick={() => void load(true)}
            >
              打印订单
            </button>
          </div>
        </div>
        {busy && <p role="status">正在核验订单与收件信息…</p>}
        {error && (
          <div role="alert" className="notice task-error">
            {error}
            <button className="secondary-button" disabled={busy} onClick={() => void load()}>
              重试打印预览
            </button>
          </div>
        )}
        <iframe
          ref={frame}
          title="订单配货单预览"
          className="redemption-print-frame"
          style={{ visibility: preview ? 'visible' : 'hidden' }}
        />
      </div>
    </dialog>
  );
}
