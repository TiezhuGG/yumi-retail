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
 *{box-sizing:border-box}body{margin:0;padding:20px;background:#eef4f0;font-family:Arial,"Microsoft YaHei",sans-serif;color:#163b30;font-size:14px;line-height:1.65}.sheet{background:white;max-width:760px;padding:30px;margin:0 auto 20px;border:1px solid #dce6df;border-radius:12px;overflow-wrap:anywhere}.brand{color:#008747;letter-spacing:2px;font-weight:bold}h1{font-size:24px;margin:8px 0}h2{font-size:16px;margin:22px 0 8px}p{margin:8px 0}.meta{color:#586f65}.recipient{border:1px solid #dce6df;padding:16px;border-radius:8px}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{padding:10px 8px;text-align:left;border-bottom:1px solid #dce6df}th{background:#f1f7f3}.total{text-align:right;font-weight:bold;font-size:17px}.foot{margin-top:24px;padding-top:12px;border-top:1px solid #dce6df;color:#586f65;font-size:12px}tr{break-inside:avoid}@page{size:A4 portrait;margin:14mm}@media print{body{padding:0;background:white;color:#111}.sheet{max-width:none;padding:0;margin:0;border:0;border-radius:0;break-after:page;page-break-after:always}.sheet:last-child{break-after:auto;page-break-after:auto}.brand{color:#111}th{background:white}.recipient{break-inside:avoid}}@media screen and (max-width:500px){body{padding:8px}.sheet{padding:16px}th,td{padding:8px 3px}}
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
  for (const o of preview.items) {
    const sheet = node('article', undefined, 'sheet');
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
    sheet.append(recipient);
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
    sheet.append(
      table,
      node('p', '合计：' + o.totalPoints + ' 积分', 'total'),
      node('p', '核对人：________________    核对日期：________________'),
      node(
        'p',
        '本单为订单配货单，非快递电子面单。打印不代表已发货，发货状态以系统记录为准。',
        'foot',
      ),
      node('p', '预览生成时间：' + stamp(preview.generatedAt) + '（北京时间）', 'meta'),
    );
    d.body.append(sheet);
  }
}
export function RedemptionPrintDialog({
  ids,
  profile,
  onClose,
}: {
  ids: string[];
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
        '/admin/redemptions/print-preview',
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
            <h2>订单打印预览</h2>
            <p>已选择 {ids.length} 单 · A4 每单分页 · 打印不改变发货状态</p>
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
