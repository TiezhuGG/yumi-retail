import { useEffect, useRef, useState } from 'react';
import {
  waybillCsvTemplate,
  WAYBILL_CSV_MAX_BYTES,
  formatRedemptionAddress,
  type WaybillImportPreview,
  type StaffProfile,
} from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';
type Intent = {
  key: string;
  body: {
    items: Array<{
      id: string;
      version: number;
      carrierCode: string;
      carrierName: string;
      trackingNo: string;
    }>;
    dispatchConfirmed: true;
  };
};
export const waybillImportStorage = (p: StaffProfile) =>
  'yumi.waybill-import.v1:' + p.id + ':' + [...p.warehouseIds].sort().join(',');
export function WaybillImportDialog({
  profile,
  orderNos,
  onClose,
  onDone,
}: {
  profile: StaffProfile;
  orderNos: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [csv, setCsv] = useState(''),
    [filename, setFilename] = useState(''),
    [view, setView] = useState<WaybillImportPreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [pending, setPending] = useState(!!sessionStorage.getItem(waybillImportStorage(profile))),
    [done, setDone] = useState<{ count: number } | null>(null);
  const seq = useRef(0),
    working = useRef(false);
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );
  function download() {
    const url = URL.createObjectURL(
      new Blob([waybillCsvTemplate(orderNos)], { type: 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = '兑换订单运单导入模板.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
  async function file(file: File | undefined) {
    const n = ++seq.current;
    setView(null);
    setConfirmed(false);
    setCsv('');
    setError('');
    setFilename('');
    if (!file) return;
    if (!/\.csv$/i.test(file.name) || file.size > WAYBILL_CSV_MAX_BYTES) {
      setError('请选择不超过32KB的UTF-8 CSV文件');
      return;
    }
    try {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (n === seq.current) {
        setCsv(value);
        setFilename(file.name);
      }
    } catch {
      if (n === seq.current) setError('文件编码无效，请另存为CSV UTF-8后重新选择');
    }
  }
  async function preview() {
    if (working.current || pending) return;
    working.current = true;
    const n = ++seq.current;
    setBusy(true);
    setError('');
    setView(null);
    setConfirmed(false);
    try {
      const v = await staffRequest<WaybillImportPreview>(
        '/admin/redemptions/waybill-import/preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
          body: JSON.stringify({ csv }),
        },
      );
      if (n === seq.current) setView(v);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '导入预检失败');
    } finally {
      working.current = false;
      if (n === seq.current) setBusy(false);
    }
  }
  async function submit() {
    if (working.current || (!pending && (!view?.canShip || !confirmed))) return;
    working.current = true;
    const n = ++seq.current;
    setBusy(true);
    setError('');
    try {
      const raw = sessionStorage.getItem(waybillImportStorage(profile));
      const intent: Intent = raw
        ? JSON.parse(raw)
        : {
            key: crypto.randomUUID(),
            body: {
              items: view!.items.map((o) => ({
                id: o.id,
                version: o.version,
                carrierCode: o.carrierCode,
                carrierName: o.carrierName,
                trackingNo: o.trackingNo,
              })),
              dispatchConfirmed: true,
            },
          };
      if (!intent?.key || !Array.isArray(intent.body?.items))
        throw Error('原导入请求无法读取，请保留并核查');
      sessionStorage.setItem(waybillImportStorage(profile), JSON.stringify(intent));
      setPending(true);
      const result = await staffRequest<{ items: Array<{ id: string }> }>(
        '/admin/redemptions/waybill-import/confirm',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': profile.csrfToken,
            'Idempotency-Key': intent.key,
          },
          body: JSON.stringify(intent.body),
        },
      );
      sessionStorage.removeItem(waybillImportStorage(profile));
      if (n === seq.current) {
        setPending(false);
        setDone({ count: result.items.length });
        setView(null);
        setCsv('');
      }
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof StaffRequestError && e.status < 500 && ![401, 403].includes(e.status)) {
          sessionStorage.removeItem(waybillImportStorage(profile));
          setPending(false);
          setView(null);
          setConfirmed(false);
        }
        setError(e instanceof Error ? e.message : '结果待核实，请保留原请求');
      }
    } finally {
      working.current = false;
      if (n === seq.current) setBusy(false);
    }
  }
  return (
    <Modal title="批量运单导入" busy={busy} onClose={() => (done ? onDone() : onClose())}>
      {done ? (
        <div className="notice" role="status">
          <h3>整批发货已登记</h3>
          <p>本批{done.count}笔订单已完成出库与运单登记。</p>
          <button className="primary-button" onClick={onDone}>
            完成并返回订单
          </button>
        </div>
      ) : (
        <>
          {error && (
            <p role="alert" className="notice task-error">
              {error}
            </p>
          )}
          {busy && <p role="status">{pending ? '正在核实整批发货结果…' : '正在预检订单与运单…'}</p>}
          {pending ? (
            <div className="notice">
              <p>有一笔批量发货请求待核实，请使用原请求确认，避免重复出库。</p>
              <button className="primary-button" disabled={busy} onClick={() => void submit()}>
                核实原批量发货请求
              </button>
            </div>
          ) : (
            <>
              <p>
                每行一笔订单、一份运单，最多20单。请填写快递公司代码与真实运单号；需要同包发货时使用合包入口。
              </p>
              <button className="secondary-button" onClick={download} disabled={busy}>
                {orderNos.length ? '下载已选待发货订单模板' : '下载空白模板'}
              </button>
              <details>
                <summary>填写说明与快递公司代码</summary>
                <p>
                  CSV
                  UTF-8格式，表头及顺序保持不变：订单号、快递公司代码、快递公司名称、运单号。标准快递的名称可留空；OTHER必须填名称。订单号、运单号请按文本填写。
                </p>
                <p>
                  SF 顺丰、ZTO 中通、YTO 圆通、STO 申通、YUNDA 韵达、JD 京东、EMS、POST 邮政、DEPPON
                  德邦、OTHER 其他。
                </p>
              </details>
              <label className="waybill-file-label">
                选择运单文件
                <input
                  type="file"
                  accept=".csv,text/csv"
                  aria-label="运单CSV文件"
                  disabled={busy}
                  onChange={(e) => void file(e.target.files?.[0])}
                />
              </label>
              {filename && <p className="muted">已选择：{filename}</p>}
              <button
                className="secondary-button"
                disabled={!csv || busy}
                onClick={() => void preview()}
              >
                预检导入
              </button>
              {view?.issues.length ? (
                <div role="alert" className="notice task-error">
                  <h3>本批不能发货，请修正后重新导入</h3>
                  <ul>
                    {view.issues.map((x) => (
                      <li key={x.row}>
                        第{x.row}行 · {x.orderNo}：{x.message}
                      </li>
                    ))}
                  </ul>
                  <p>未登记运单，未出库。</p>
                </div>
              ) : null}
              {view?.canShip && (
                <>
                  <h3>预检通过 · {view.items.length}笔订单</h3>
                  <p>请逐单核对以下原收件信息、预占实物及对应运单。提交时会再次核验。</p>
                  <ul className="parcel-order-list">
                    {view.items.map((o) => (
                      <li key={o.id}>
                        <h3>
                          {o.title} · {o.spec} × {o.quantity}
                          {o.unit}
                        </h3>
                        <p>订单：{o.orderNo}</p>
                        <p>
                          {o.executionMode === 'PRODUCTION'
                            ? '生产订单'
                            : o.executionMode === 'CONTROLLED'
                              ? '受控测试订单'
                              : '本地开发订单'}
                        </p>
                        <p>
                          {o.address.contactName} · {o.address.phone}
                        </p>
                        <p>{formatRedemptionAddress(o.address)}</p>
                        {o.address.note && <p>地址备注：{o.address.note}</p>}
                        {o.address.orderNote && <p>订单备注：{o.address.orderNote}</p>}
                        <p>
                          <strong>
                            {o.carrierName} · {o.trackingNo}
                          </strong>
                        </p>
                        {o.allocations.map((a, i) => (
                          <p key={i}>
                            批次 {a.batchNo} · 库位 {a.locationName} · {a.quantity}
                            {o.unit}
                          </p>
                        ))}
                      </li>
                    ))}
                  </ul>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={busy}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    已逐单核对原收件信息、实物与对应真实运单，确认全部已交给快递
                  </label>
                  <p>任一订单状态或库存变化，本批全部不出库。</p>
                  <button
                    className="primary-button"
                    disabled={!confirmed || busy}
                    onClick={() => void submit()}
                  >
                    确认整批发货（{view.items.length}单）
                  </button>
                </>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}
