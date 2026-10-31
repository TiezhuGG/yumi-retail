import { useEffect, useRef, useState } from 'react';
import type { ReceiptSkuLookup } from '@yumi/contracts';
import { staffRequest } from './index.js';

export function ReceiptBarcodePicker({
  root,
  duplicateIds,
  onPick,
}: {
  root: string;
  duplicateIds: string[];
  onPick: (sku: ReceiptSkuLookup) => void;
}) {
  const [barcode, setBarcode] = useState(''),
    [result, setResult] = useState<ReceiptSkuLookup | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [picked, setPicked] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    sequence.current++;
    setResult(null);
    setError('');
    setLoading(false);
    setPicked(false);
    return () => {
      sequence.current++;
    };
  }, [root]);
  async function lookup() {
    if (loading) return;
    if (!/^[0-9]{1,64}$/.test(barcode.trim())) {
      setError('请填写1–64位数字的完整条码');
      return;
    }
    const token = ++sequence.current;
    setLoading(true);
    setError('');
    setResult(null);
    setPicked(false);
    try {
      const sku = await staffRequest<ReceiptSkuLookup>(
        `${root}/skus/by-barcode?barcode=${encodeURIComponent(barcode.trim())}`,
      );
      if (token === sequence.current) setResult(sku);
    } catch (e) {
      if (token === sequence.current)
        setError(e instanceof Error ? e.message : '条码查询失败，请重试');
    } finally {
      if (token === sequence.current) setLoading(false);
    }
  }
  const duplicate = !!result && duplicateIds.includes(result.id);
  return (
    <div className="receipt-barcode-picker">
      <label>
        按条码查找商品
        <input
          inputMode="numeric"
          value={barcode}
          placeholder="手动输入完整条码，保留前导零"
          onChange={(e) => {
            sequence.current++;
            setBarcode(e.target.value);
            setResult(null);
            setError('');
            setLoading(false);
            setPicked(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              void lookup();
            }
          }}
        />
      </label>
      <button
        type="button"
        className="secondary-button"
        disabled={loading || !barcode.trim()}
        onClick={() => void lookup()}
      >
        {loading ? '正在查询条码…' : '查询条码'}
      </button>
      {loading && <p role="status">正在按完整条码查询，草稿保持原值…</p>}
      {error && (
        <p className="task-error" role="alert">
          {error}（草稿未改动，可重新查询或手动选择）
        </p>
      )}
      {result && (
        <div className="notice" style={{ overflowWrap: 'anywhere' }}>
          <strong>{result.name}</strong>
          <p>
            {result.spec} / {result.unit} · {result.code}
          </p>
          <p>
            {!result.enabled
              ? '规格已停用，不能选入收货单。'
              : duplicate
                ? '此SKU已在其他明细中，请核对原行；不会重复增加数量。'
                : '请核对名称和规格，再选入本行；批次、数量、成本及效期保持当前填写。'}
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={!result.enabled || duplicate || picked}
            onClick={() => {
              onPick(result);
              setPicked(true);
            }}
          >
            选入本行
          </button>
          {picked && <p role="status">已选入本行，请核对后填写收货资料。</p>}
        </div>
      )}
    </div>
  );
}
