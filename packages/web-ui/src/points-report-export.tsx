import { useEffect, useRef, useState } from 'react';
import {
  POINTS_REPORT_KIND_LABELS,
  type PointsReportExport,
  type PointsReportKind,
  type StaffProfile,
} from '@yumi/contracts';
import { staffRequest } from './index.js';
import { Modal } from './modal.js';
export interface PointsReportExportFilter {
  from: string;
  to: string;
  dataset: 'LEDGER' | 'DAILY';
  kind?: PointsReportKind;
}
export function PointsReportExportDialog({
  filter,
  profile,
  onClose,
}: {
  filter: PointsReportExportFilter;
  profile: StaffProfile;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState<PointsReportExport | null>(null);
  const working = useRef(false),
    seq = useRef(0);
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );
  function download(file: PointsReportExport) {
    const url = URL.createObjectURL(new Blob([file.csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file.filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function generate() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setResult(null);
    const n = ++seq.current;
    try {
      const file = await staffRequest<PointsReportExport>('/admin/points/report/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
        body: JSON.stringify(filter),
      });
      if (n !== seq.current) return;
      setResult(file);
      download(file);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '导出失败，请重试');
    } finally {
      working.current = false;
      if (n === seq.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={filter.dataset === 'LEDGER' ? '导出积分入账明细' : '导出每日积分汇总'}
      busy={busy}
      onClose={onClose}
    >
      <dl className="points-export-scope">
        <div>
          <dt>日期范围（北京时间）</dt>
          <dd>
            {filter.from} 至 {filter.to}（含结束当日）
          </dd>
        </div>
        <div>
          <dt>积分类型</dt>
          <dd>{filter.kind ? POINTS_REPORT_KIND_LABELS[filter.kind] : '全部类型'}</dd>
        </div>
        <div>
          <dt>导出内容</dt>
          <dd>
            {filter.dataset === 'LEDGER'
              ? '当前授权仓的全部匹配入账明细，最多5000行，不受列表分页影响'
              : '当前授权仓每日增加、扣减及净变动，包含全部积分类型'}
          </dd>
        </div>
      </dl>
      <p>
        UTF-8
        CSV格式。导出按生成时的数据重新查询，不修改积分；未归属流水、全历史差异和全局账户余额不包含在文件中。
      </p>
      <p className="muted">
        超过15位的积分整数按文本保留；昵称或依据中可能被识别为公式的内容会加单引号。导出操作留存审计。
      </p>
      {busy && <p role="status">正在生成积分报表文件…</p>}
      {error && (
        <p role="alert" className="notice task-error">
          {error}
        </p>
      )}
      {result ? (
        <div className="notice" role="status">
          <h3>导出文件已生成</h3>
          <p>
            {result.rowCount}行 · {result.filename}
          </p>
          {result.rowCount === 0 && <p>当前范围暂无入账数据，文件仅包含表头。</p>}
          <p>
            生成时间：
            {new Date(result.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
            （北京时间）
          </p>
          <button className="secondary-button" onClick={() => download(result)}>
            再次下载文件
          </button>
        </div>
      ) : (
        <button className="primary-button" disabled={busy} onClick={() => void generate()}>
          {busy ? '正在生成…' : error ? '重试生成并下载' : '生成并下载CSV'}
        </button>
      )}
    </Modal>
  );
}
