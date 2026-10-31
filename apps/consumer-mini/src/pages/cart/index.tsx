import { useEffect, useRef, useState } from 'react';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { View, Text, Button } from '@tarojs/components';
import { guestCart } from '../../cart-storage';
import {
  cartIdentity,
  readAccountCart,
  cartRequest,
  mergeGuest,
  pendingMerge,
} from '../../account-cart';
import type { CartIdentity } from '../../account-cart';
import type { ConsumerCart } from '../../../../../packages/contracts/src/index';
import type { CartItem } from '../../guest-cart';
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
  const operation = useRef(false);
  const guestViewRef = useRef(false);
  const [identity, setIdentity] = useState<CartIdentity | null>(null);
  const [accountMode, setAccountMode] = useState(false);
  const [cartVersion, setCartVersion] = useState(0);
  const [guestCount, setGuestCount] = useState(0);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
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
    setDraft(null);
    setIdentity(null);
    setAccountMode(false);
    try {
      const local = guestCart.read();
      setGuestCount(local.items.length);
      setPending(!!pendingMerge());
      const actor = await cartIdentity();
      if (token !== sequence.current) return;
      setIdentity(actor);
      const remote = actor && !guestViewRef.current ? await readAccountCart(actor) : null;
      if (token !== sequence.current) return;
      setAccountMode(!!remote);
      setCartVersion(remote?.version ?? 0);
      const current: CartDraft = remote ? { version: 1, items: remote.items } : local;
      setDraft(current);
      setUncertain(false);
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
      setGuestCount(next.items.length);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  }
  async function mutate(path: string, body: unknown, method: 'POST' | 'PUT' | 'DELETE') {
    if (!identity || operation.current || uncertain || pending) return;
    operation.current = true;
    const current = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      await cartRequest<ConsumerCart>(identity, path, body, method);
      if (current === sequence.current) await refresh();
    } catch (e) {
      if (current === sequence.current) {
        setUncertain(true);
        setError(
          (e instanceof Error ? e.message : '暂未确认保存结果') +
            '；请先重新读取购物车，再决定下一次操作。',
        );
      }
    } finally {
      operation.current = false;
      if (current === sequence.current) setBusy(false);
    }
  }
  function update(item: CartItem, delta = 0, toggle = false) {
    if (accountMode)
      void mutate(
        `/consumer/cart/items/${item.skuId}`,
        {
          version: cartVersion,
          quantity: item.quantity + delta,
          selected: toggle ? !item.selected : item.selected,
        },
        'PUT',
      );
    else
      change(() => (toggle ? guestCart.toggle(item.skuId) : guestCart.adjust(item.skuId, delta)));
  }
  async function merge() {
    if (!identity || operation.current) return;
    const answer = pending
      ? { confirm: true }
      : await Taro.showModal({
          title: '合并到当前账号？',
          content: `将本机草稿合并到${identity.profile.user.displayName}。相同规格数量相加，已有勾选状态保留；失效或缺货项也会保留。`,
          confirmText: '确认合并',
        });
    if (!answer.confirm || operation.current) return;
    operation.current = true;
    const current = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      await mergeGuest(identity);
      if (current === sequence.current) {
        guestViewRef.current = false;
        await refresh();
        void Taro.showToast({ title: '合并已确认', icon: 'success' });
      }
    } catch (e) {
      if (current === sequence.current) {
        setError(e instanceof Error ? e.message : '合并结果未知，请保留原稿并重试');
        try {
          setPending(!!pendingMerge());
        } catch {
          /* Keep the original merge error and all local data for recovery. */
        }
      }
    } finally {
      operation.current = false;
      if (current === sequence.current) setBusy(false);
    }
  }
  function switchView() {
    if (operation.current) return;
    guestViewRef.current = !guestViewRef.current;
    void refresh();
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
        <Text className="cart-title">{accountMode ? '账号购物车' : '本机购物车草稿'}</Text>
        <Button disabled={busy} onClick={() => void refresh()}>
          {busy ? '正在核验…' : '刷新价格与库存'}
        </Button>
      </View>
      <View className="cart-note">
        {accountMode
          ? `当前账号：${identity?.profile.user.displayName}。账号购物车保存到服务端。`
          : '草稿仅保存在这台设备。'}
        购物车不占库存；参考小计不含配送费，不是下单报价，结算尚未开放。
      </View>
      {identity && (
        <View className="cart-merge-panel">
          <Text>
            {pending
              ? '有一笔合并待确认，原稿已冻结；请使用原账号重试，勿重复提交。'
              : `本机草稿有${guestCount}种规格，可确认后合并到当前账号。`}
          </Text>
          <Button disabled={busy} onClick={() => void switchView()}>
            {accountMode ? '查看本机草稿' : '返回账号购物车'}
          </Button>
          {(guestCount > 0 || pending) && (
            <Button className="cart-merge-button" disabled={busy} onClick={() => void merge()}>
              {pending ? '重试确认原合并' : '将本机草稿合并到当前账号'}
            </Button>
          )}
        </View>
      )}
      {!identity && pending && (
        <View className="cart-merge-panel">
          <Text>
            原账号有一笔合并待确认。请前往“我的”恢复原身份，再重试；原稿已保留且暂不可修改。
          </Text>
        </View>
      )}
      {!identity && (
        <Button
          className="cart-account-link"
          onClick={() => void Taro.navigateTo({ url: '/pages/account/index' })}
        >
          前往“我的”核验登录
        </Button>
      )}
      {error && (
        <View className="store-feedback">
          <Text>{error}</Text>
          <Button onClick={() => void refresh()}>重新读取购物车</Button>
          {!draft && !accountMode && !pending && (
            <Button onClick={() => void reset()}>重置本机草稿</Button>
          )}
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
              disabled={pending || (accountMode && (busy || uncertain))}
              onClick={() => update(item, 0, true)}
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
                    disabled={item.quantity <= 1 || pending || (accountMode && (busy || uncertain))}
                    onClick={() => update(item, -1)}
                  >
                    −
                  </Button>
                  <Text>{item.quantity}</Text>
                  <Button
                    aria-label={`增加${item.name}`}
                    disabled={pending || (accountMode && (busy || uncertain))}
                    onClick={() => update(item, 1)}
                  >
                    ＋
                  </Button>
                </View>
                <Button
                  className="cart-remove"
                  disabled={pending || (accountMode && (busy || uncertain))}
                  onClick={() =>
                    accountMode
                      ? void mutate(
                          `/consumer/cart/items/${item.skuId}`,
                          { version: cartVersion },
                          'DELETE',
                        )
                      : change(() => guestCart.remove(item.skuId))
                  }
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
            disabled={pending || (accountMode && (busy || uncertain))}
            onClick={() =>
              accountMode
                ? void mutate(
                    '/consumer/cart/selection',
                    {
                      version: cartVersion,
                      skuIds: valid.map((i) => i.skuId),
                      selected: !allSelected,
                    },
                    'POST',
                  )
                : change(() =>
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
          {accountMode ? (
            <Button
              disabled={busy || uncertain || pending || !items.some((i) => i.selected)}
              onClick={() => void Taro.navigateTo({ url: '/pages/checkout/index' })}
            >
              结算前核验
            </Button>
          ) : (
            <Button disabled>登录账号后可核验费用</Button>
          )}
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
