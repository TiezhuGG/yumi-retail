import { useEffect, useRef, useState } from 'react';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { View, Text, Button } from '@tarojs/components';
import { guestCart } from '../../cart-storage';
import { cartSummary, checkCart } from '../../guest-cart';
import type { CartDraft, CartCheck } from '../../guest-cart';
import { request, CatalogRequestError } from '../../api';
import type { SaleSku } from '../../api';
import { ProductVisual } from '../../components/ProductVisual';
export default function Cart() {
  const [draft, setDraft] = useState<CartDraft | null>(null),
    [checks, setChecks] = useState<Record<string, CartCheck>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const sequence = useRef(0);
  useDidHide(() => {
    sequence.current++;
  });
  useEffect(() => {
    if (error) void Taro.pageScrollTo({ scrollTop: 0, duration: 0 }).catch(() => {});
  }, [error]);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  async function refresh() {
    const token = ++sequence.current;
    setBusy(true);
    setError('');
    setChecks({});
    try {
      const current = guestCart.read();
      setDraft(current);
      await checkCart(
        current.items,
        (id) => request<SaleSku>(`/products/${id}`),
        (e) => e instanceof CatalogRequestError && e.status === 404,
        (next) => {
          if (token === sequence.current) setChecks(next);
        },
        () => token !== sequence.current,
      );
    } catch (e) {
      if (token === sequence.current) {
        setDraft(null);
        setError(e instanceof Error ? e.message : '购物车读取失败');
      }
    } finally {
      if (token === sequence.current) setBusy(false);
    }
  }
  useDidShow(() => {
    void refresh();
  });
  function change(action: () => CartDraft) {
    try {
      const next = action();
      setDraft(next);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  }
  async function reset() {
    const result = await Taro.showModal({
      title: '重置本机购物车？',
      content: '将删除这台设备当前保存的购物车草稿，无法撤销。',
      confirmText: '重置草稿',
    });
    if (result.confirm) {
      sequence.current++;
      change(() => guestCart.reset());
      setChecks({});
      setBusy(false);
    }
  }
  const items = draft?.items ?? [],
    summary = cartSummary(items, checks);
  const valid = items.filter(
    (i) =>
      checks[i.skuId]?.status === 'ready' &&
      (checks[i.skuId] as { status: 'ready'; sku: SaleSku }).sku.available >= i.quantity,
  );
  const allSelected = valid.length > 0 && valid.every((i) => i.selected);
  return (
    <View className="cart-page">
      <View className="cart-heading">
        <Text className="cart-title">购物车草稿</Text>
        <Button disabled={busy} onClick={() => void refresh()}>
          {busy ? '正在核验…' : '刷新价格与库存'}
        </Button>
      </View>
      <View className="cart-note">
        草稿仅保存在这台设备，不占库存；数量按所选规格的售卖单位计。参考小计不含配送费，不是下单报价；登录合并与结算尚未开放。
      </View>
      {error && (
        <View className="store-feedback">
          <Text>{error}</Text>
          <Button onClick={() => void refresh()}>重新读取草稿</Button>
          {!draft && <Button onClick={() => void reset()}>重置本机草稿</Button>}
        </View>
      )}
      {draft && items.length === 0 && (
        <View className="store-feedback cart-empty">
          <Text>购物车还是空的</Text>
          <Text className="feedback-copy">去商品详情选好规格，再加入草稿吧</Text>
          <Button onClick={() => void Taro.reLaunch({ url: '/pages/index/index' })}>
            去逛好物
          </Button>
        </View>
      )}
      {items.map((item) => {
        const check = checks[item.skuId],
          sku = check?.status === 'ready' ? check.sku : null;
        const status = !check
          ? '正在核验'
          : check.status === 'gone'
            ? '商品已失效'
            : check.status === 'unknown'
              ? '暂未核验'
              : sku!.available < 1
                ? '暂时缺货'
                : sku!.available < item.quantity
                  ? '数量超出当前可用量'
                  : '本次读取可用';
        const included = !!sku && sku.available >= item.quantity;
        return (
          <View key={item.skuId} className="cart-row">
            <Button
              className={`cart-check ${item.selected ? 'selected' : ''}`}
              aria-label={`${item.selected ? '取消勾选' : '勾选'}${item.name}`}
              onClick={() => change(() => guestCart.toggle(item.skuId))}
            >
              {item.selected ? '✓' : '○'}
            </Button>
            <View className="cart-row-main">
              <View
                className="cart-product"
                onClick={() =>
                  void Taro.navigateTo({ url: `/pages/product/index?id=${item.skuId}` })
                }
              >
                <ProductVisual name={sku?.name ?? item.name} imageUrl={sku?.imageUrl} />
                <View className="cart-product-copy">
                  <Text className="cart-product-name">{sku?.name ?? item.name}</Text>
                  <Text className="cart-product-spec">
                    {sku?.spec ?? item.spec} / {sku?.unit ?? item.unit}
                  </Text>
                  {!sku && <Text className="cart-muted">上次保存的商品名称</Text>}
                </View>
              </View>
              <View className={`cart-status ${included ? 'ok' : ''}`}>
                {status}
                {!included && ' · 未计入参考小计'}
              </View>
              {check?.status === 'unknown' && <Text className="cart-muted">{check.message}</Text>}
              <View className="cart-row-bottom">
                <Text className="cart-price">
                  {sku ? `¥${(sku.priceCents / 100).toFixed(2)}` : '价格待核验'}
                </Text>
                <View className="cart-stepper">
                  <Button
                    aria-label={`减少${item.name}`}
                    disabled={item.quantity <= 1}
                    onClick={() => change(() => guestCart.adjust(item.skuId, -1))}
                  >
                    −
                  </Button>
                  <Text>{item.quantity}</Text>
                  <Button
                    aria-label={`增加${item.name}`}
                    onClick={() => change(() => guestCart.adjust(item.skuId, 1))}
                  >
                    ＋
                  </Button>
                </View>
                <Button
                  className="cart-remove"
                  onClick={() => change(() => guestCart.remove(item.skuId))}
                >
                  移除
                </Button>
              </View>
            </View>
          </View>
        );
      })}
      {!!items.length && (
        <View className="cart-selection">
          <Button
            onClick={() =>
              change(() =>
                guestCart.select(
                  valid.map((i) => i.skuId),
                  !allSelected,
                ),
              )
            }
          >
            {allSelected ? '取消全选可用项' : '全选可用项'}
          </Button>
          <Text>
            {items.length}种规格 · 共{items.reduce((n, i) => n + i.quantity, 0)}件
          </Text>
        </View>
      )}
      {!!items.length && (
        <View className="cart-summary">
          <Text>已勾选可用项参考小计</Text>
          <Text className="cart-total">¥{(summary.totalCents / 100).toFixed(2)}</Text>
          <Text>
            {summary.units}件已计入{summary.excluded ? ` · ${summary.excluded}项待处理未计入` : ''}
          </Text>
          <Button disabled>结算尚未开放</Button>
        </View>
      )}
      <Button
        className="cart-home"
        onClick={() => void Taro.reLaunch({ url: '/pages/index/index' })}
      >
        继续逛好物
      </Button>
    </View>
  );
}
