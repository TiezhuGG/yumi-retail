import { useEffect, useRef, useState } from 'react';
import type { RewardReadiness, StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { ProductEditor } from './product-editor.js';
import { ProductImageEditor } from './product-image-editor.js';
import { SkuEditor } from './sku-editor.js';
import { CategoryEditor } from './category-editor.js';
import { Modal } from './modal.js';
export type RewardCheckDestination = 'stock' | 'redemptions' | 'express-readiness';
const labels = { READY: '已就绪', WARNING: '需留意', BLOCKING: '需先处理', INFO: '状态说明' };
export function RewardReadinessPanel({
  id,
  profile,
  onEditReward,
  onSnapshot,
  onNavigate,
}: {
  id: string;
  profile: StaffProfile;
  onEditReward: () => void;
  onSnapshot: (value: RewardReadiness['reward']) => void;
  onNavigate?: (view: RewardCheckDestination) => void;
}) {
  const [report, setReport] = useState<RewardReadiness | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [editor, setEditor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [conflict, setConflict] = useState(false);
  const sequence = useRef(0),
    pending = useRef<{ path: string; body: { version: number }; key: string } | null>(null),
    writing = useRef(false);
  async function load() {
    const n = ++sequence.current;
    setLoading(true);
    setError('');
    setReport(null);
    try {
      const d = await staffRequest<RewardReadiness>('/admin/rewards/' + id + '/readiness');
      if (n === sequence.current) {
        setReport(d);
        onSnapshot(d.reward);
      }
    } catch (e) {
      if (n === sequence.current) setError(e instanceof Error ? e.message : '检查读取失败');
    } finally {
      if (n === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [id]);
  const canEdit = profile.permissions.includes('catalog.write');
  async function closeEditor() {
    setEditor(null);
    setUnknown(false);
    setConflict(false);
    pending.current = null;
    await load();
  }
  async function publishSource() {
    if (!report || writing.current || conflict) return;
    if (!pending.current)
      pending.current = {
        path: '/admin/products/' + report.product.id + '/publish',
        body: { version: report.product.version },
        key: crypto.randomUUID(),
      };
    const intent = pending.current;
    writing.current = true;
    setBusy(true);
    setError('');
    try {
      await staffRequest(intent.path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': intent.key,
        },
        body: JSON.stringify(intent.body),
      });
    } catch (e) {
      const uncertain = !(e instanceof StaffRequestError) || e.status >= 500;
      setUnknown(uncertain);
      if (!uncertain) {
        pending.current = null;
        setConflict(true);
      }
      setError(
        uncertain
          ? '上架结果未确认，请保留原请求重试。'
          : e instanceof Error
            ? e.message
            : '上架失败',
      );
      writing.current = false;
      setBusy(false);
      return;
    }
    writing.current = false;
    setBusy(false);
    await closeEditor();
  }
  function action(check: RewardReadiness['checks'][number]) {
    if (!report) return null;
    const a = check.action;
    if (!a) return null;
    if (a === 'REWARD')
      return (
        <button className="secondary-button" onClick={onEditReward}>
          维护兑换规则
        </button>
      );
    if (a === 'STOCK')
      return onNavigate && profile.permissions.includes('stock.read') ? (
        <button className="secondary-button" onClick={() => onNavigate('stock')}>
          查看库存
        </button>
      ) : (
        <small>库存由有权限的仓库人员维护</small>
      );
    if (a === 'SHIPPING')
      return onNavigate ? (
        <button className="secondary-button" onClick={() => onNavigate('redemptions')}>
          配置快递范围
        </button>
      ) : null;
    if (a === 'STORE')
      return onNavigate ? (
        <button className="secondary-button" onClick={() => onNavigate('express-readiness')}>
          查看首发条件
        </button>
      ) : null;
    if (!canEdit) return null;
    const title =
      a === 'IMAGE'
        ? '管理图片'
        : a === 'SKU'
          ? '维护规格与售价'
          : a === 'CATEGORY'
            ? '维护分类'
            : a === 'PUBLISH_SOURCE'
              ? '上架基础商品'
              : '编辑商品资料';
    return (
      <button className="secondary-button" onClick={() => setEditor(a)}>
        {title}
      </button>
    );
  }
  return (
    <div className="reward-readiness-panel">
      <div className="readiness-heading">
        <div>
          <h2>上架前检查</h2>
          <p>检查是当前快照，提交时仍以服务端最新校验为准。</p>
        </div>
        <button className="secondary-button" disabled={loading} onClick={() => void load()}>
          刷新商品检查
        </button>
      </div>
      {loading && (
        <div className="surface" role="status">
          正在检查商品…
        </div>
      )}
      {error && !editor && (
        <div className="notice task-error" role="alert">
          {error}
          <button className="secondary-button" disabled={loading} onClick={() => void load()}>
            重试商品检查
          </button>
        </div>
      )}
      {report && (
        <>
          <div className="surface readiness-summary">
            <h3>
              {report.reward.status === 'PUBLISHED'
                ? '商品已上架'
                : report.canPublish
                  ? '当前符合上架条件'
                  : '上架前需先处理'}
            </h3>
            <p>
              {report.displayableNow ? '当前符合公开展示条件。' : '当前未符合公开展示条件。'}{' '}
              本仓可用库存 {report.inventoryAvailable} 件，实际兑换仍需校验身份、积分和库存。
            </p>
            <small>
              检查时间：
              {new Date(report.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
            </small>
          </div>
          <div className="readiness-checks">
            {report.checks.map((c) => (
              <article key={c.code} className="readiness-check">
                <div>
                  <h3>{c.title}</h3>
                  <span className={'badge ' + (c.status === 'READY' ? 'green' : 'amber')}>
                    {labels[c.status]}
                  </span>
                </div>
                <p>{c.detail}</p>
                {action(c)}
              </article>
            ))}
          </div>
          {editor === 'PRODUCT' && (
            <ProductEditor
              id={report.product.id}
              profile={profile}
              onClose={() => void closeEditor()}
              onSaved={closeEditor}
            />
          )}
          {editor === 'IMAGE' && (
            <ProductImageEditor
              id={report.product.id}
              profile={profile}
              onClose={() => void closeEditor()}
              onSaved={closeEditor}
            />
          )}
          {editor === 'SKU' && (
            <SkuEditor
              id={report.product.id}
              skuId={report.reward.skuId}
              profile={profile}
              onClose={() => void closeEditor()}
              onSaved={closeEditor}
            />
          )}
          {editor === 'CATEGORY' && (
            <CategoryEditor
              id={report.product.categoryToEditId}
              profile={profile}
              onClose={() => void closeEditor()}
              onSaved={closeEditor}
            />
          )}
          {editor === 'PUBLISH_SOURCE' && (
            <Modal title="上架基础商品" busy={busy || unknown} onClose={() => void closeEditor()}>
              <p>上架基础商品会影响该商品的全部规格。积分商品仍须单独上架。</p>
              {error && (
                <p role="alert" className="notice task-error">
                  {error}
                </p>
              )}
              <button
                className="primary-button"
                disabled={busy || conflict}
                onClick={() => void publishSource()}
              >
                {unknown ? '使用原请求重试上架' : '确认上架基础商品'}
              </button>
              {!unknown && (
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void closeEditor()}
                >
                  关闭并重新检查
                </button>
              )}
            </Modal>
          )}
        </>
      )}
    </div>
  );
}
