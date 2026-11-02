import { PointsGrants } from './points-grants.js';
import { PointsWorkbench } from './points.js';
import { DeliveryLabWorkbench } from './delivery-lab.js';
import { PickingLabWorkbench } from './picking-lab.js';
import { PickingReadinessWorkbench } from './picking-readiness.js';
import type { PaymentReviewDestination, OpenPaymentReview } from './payment-navigation.js';
import { PaymentAdapterLabWorkbench } from './payment-adapter-lab.js';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { StaffProfile } from '@yumi/contracts';
import { CheckoutPolicyWorkbench } from './checkout-policy.js';
import { ServiceAreaWorkbench } from './service-area.js';
import { CatalogWorkbench } from './catalog.js';
import { PaymentReadinessWorkbench } from './payment-readiness.js';
import { NotificationRecordsWorkbench } from './notification-records.js';
import { PaymentReviewLabWorkbench } from './payment-review-lab.js';
import { PaymentAttemptLabWorkbench } from './payment-attempt-lab.js';
import { PaymentCloseLabWorkbench } from './payment-close-lab.js';
import { NotificationLabWorkbench } from './notification-lab.js';
import { OrderWorkbench } from './orders.js';
import { Brand } from './brand.js';
export type WorkspaceView =
  | 'points-grants'
  | 'points'
  | 'delivery-lab'
  | 'picking-lab'
  | 'picking-readiness'
  | 'overview'
  | 'products'
  | 'categories'
  | 'receipts'
  | 'stock'
  | 'locations'
  | 'counts'
  | 'dispositions'
  | 'reversals'
  | 'service-area'
  | 'checkout-policy'
  | 'orders'
  | 'payment-readiness'
  | 'notification-lab'
  | 'notification-records'
  | 'payment-adapter-lab'
  | 'payment-close-lab'
  | 'payment-attempt-lab'
  | 'payment-review-lab';
const routes: Array<{
  id: WorkspaceView;
  name: string;
  glyph: string;
  hint: string;
  permission: string;
}> = [
  {
    id: 'points-grants',
    name: '积分发放审批',
    glyph: '◇',
    hint: '发放申请、独立审批与预算',
    permission: 'points.write',
  },
  {
    id: 'points',
    name: '积分账户',
    glyph: '◇',
    hint: '查询用户积分余额与明细',
    permission: 'points.read',
  },
  {
    id: 'overview',
    name: '工作台',
    glyph: '◫',
    hint: '今天的经营，从这里开始',
    permission: 'catalog.read',
  },
  {
    id: 'products',
    name: '商品管理',
    glyph: '▣',
    hint: '管理商品资料、规格与上下架',
    permission: 'catalog.read',
  },
  {
    id: 'categories',
    name: '商品分类',
    glyph: '▤',
    hint: '让每一件好物都井然有序',
    permission: 'catalog.read',
  },
  {
    id: 'service-area',
    name: '配送范围',
    glyph: '⌂',
    hint: '维护服务小区与楼栋白名单',
    permission: 'service-area.read',
  },
  {
    id: 'checkout-policy',
    name: '报价规则',
    glyph: '¥',
    hint: '配置运费、起送与手动报价状态',
    permission: 'checkout-policy.read',
  },
  {
    id: 'orders',
    name: '订单查询',
    glyph: '▤',
    hint: '查看订单与批次库位预占记录',
    permission: 'order.read',
  },
  {
    id: 'payment-readiness',
    name: '支付接入检查',
    glyph: '◇',
    hint: '核对配置与接入条件，真实渠道保持禁用',
    permission: 'payment-readiness.read',
  },
  {
    id: 'notification-lab',
    name: '通知隔离验证',
    glyph: '⌘',
    hint: '合成材料验证验签与解密，不处理真实支付',
    permission: 'payment-readiness.read',
  },
  {
    id: 'notification-records',
    name: '通知记录',
    hint: '合成通知持久化与重复接收验证',
    permission: 'payment-readiness.read',
    glyph: '◇',
  },
  {
    id: 'payment-adapter-lab',
    name: '渠道契约验证',
    glyph: '◇',
    hint: '合成查询响应分类，不连接真实渠道',
    permission: 'payment-readiness.read',
  },
  {
    id: 'payment-close-lab',
    name: '支付关闭验证',
    glyph: '⌘',
    hint: '支付结果与关闭竞争的隔离判定',
    permission: 'payment-readiness.read',
  },
  {
    id: 'payment-attempt-lab',
    name: '支付尝试',
    glyph: '◇',
    hint: '合成支付尝试与未知结果记录',
    permission: 'payment-readiness.read',
  },
  {
    id: 'payment-review-lab',
    name: '补偿核查',
    glyph: '▤',
    hint: '合成异常筛选与人工核查记录',
    permission: 'payment-readiness.read',
  },
  {
    id: 'delivery-lab',
    name: '配送演练',
    glyph: '◇',
    hint: '合成任务分配、接货与配送进度',
    permission: 'delivery-lab.read',
  },
  {
    id: 'picking-lab',
    name: '拣货演练',
    glyph: '◇',
    hint: '合成核对、打包与出库，独立于真实库存',
    permission: 'picking-lab.read',
  },
  {
    id: 'picking-readiness',
    name: '拣货准备',
    glyph: '▤',
    hint: '核验订单资格与已分配批次库位',
    permission: 'picking.read',
  },
  {
    id: 'stock',
    name: '库存总览',
    glyph: '▦',
    hint: '掌握库存，安心备货',
    permission: 'stock.read',
  },
  {
    id: 'receipts',
    name: '收货入库',
    glyph: '↓',
    hint: '从收货核验到库存入账',
    permission: 'receipt.read',
  },
  {
    id: 'locations',
    name: '库位与核对',
    glyph: '⌘',
    hint: '找到货品所在，核对每一笔变化',
    permission: 'stock.read',
  },
  {
    id: 'counts',
    name: '实物盘点',
    glyph: '☑',
    hint: '核实实物，让库存有据可查',
    permission: 'stock.read',
  },
  {
    id: 'dispositions',
    name: '隔离与报损',
    glyph: '◇',
    hint: '及时隔离问题货品，妥善处理损耗',
    permission: 'stock.read',
  },
  {
    id: 'reversals',
    name: '收货纠错',
    glyph: '↶',
    hint: '保留原始记录，纠正误录数量',
    permission: 'stock.read',
  },
];
type WorkspaceProps = { profile: StaffProfile; sessionControl: ReactNode; mobile?: boolean };
export function Workspace(props: WorkspaceProps) {
  const p = props.profile;
  const scope = JSON.stringify([
    p.id,
    p.csrfToken,
    [...p.permissions].sort(),
    [...p.warehouseIds].sort(),
    [...p.roles].sort(),
  ]);
  return <WorkspaceSession key={scope} {...props} />;
}
function WorkspaceSession({
  profile,
  sessionControl,
  mobile = false,
}: {
  profile: StaffProfile;
  sessionControl: ReactNode;
  mobile?: boolean;
}) {
  const pickerOnly =
    mobile && profile.roles.includes('PICKER') && !profile.permissions.includes('stock.transfer');
  const mobileViews = new Set<WorkspaceView>(
    pickerOnly
      ? ['picking-readiness', 'picking-lab', 'delivery-lab', 'stock', 'locations']
      : [
          'picking-readiness',
          'picking-lab',
          'delivery-lab',
          'overview',
          'stock',
          'receipts',
          'locations',
          'counts',
          'dispositions',
          'reversals',
        ],
  );
  const allowed = routes.filter(
    (r) => profile.permissions.includes(r.permission) && (!mobile || mobileViews.has(r.id)),
  );
  const [view, setView] = useState<WorkspaceView>(allowed[0]?.id ?? 'overview');
  const activeNav = useRef<HTMLButtonElement>(null);
  const [retained, setRetained] = useState<WorkspaceView[]>([]),
    [reviewDestination, setReviewDestination] = useState<PaymentReviewDestination>(),
    [returned, setReturned] = useState(false);
  const token = useRef(0),
    origin = useRef<{ view: WorkspaceView; element: HTMLButtonElement; top: number }>(),
    restore = useRef<{ view: WorkspaceView; element: HTMLButtonElement; top: number }>();

  useEffect(() => {
    const mobileWidth = window.matchMedia('(max-width: 680px)');
    const reveal = () => {
      const button = activeNav.current;
      const nav = button?.parentElement;
      if (!button || !nav || !mobileWidth.matches) return;
      const left =
        button.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
      nav.scrollTo({ left: left - (nav.clientWidth - button.offsetWidth) / 2 });
    };
    window.scrollTo({ top: 0, left: 0 });
    reveal();
    mobileWidth.addEventListener('change', reveal);
    return () => mobileWidth.removeEventListener('change', reveal);
  }, [view]);
  const activeView = allowed.some((r) => r.id === view) ? view : (allowed[0]?.id ?? 'overview');
  const navigate = (next: WorkspaceView) => {
    if (allowed.some((r) => r.id === next)) {
      restore.current = undefined;
      setReturned(false);
      setView(next);
    }
  };
  const retainedViews: WorkspaceView[] = [
    'delivery-lab',
    'picking-lab',
    'notification-records',
    'payment-review-lab',
    'payment-attempt-lab',
  ];
  useEffect(() => {
    if (retainedViews.includes(activeView))
      setRetained((old) => (old.includes(activeView) ? old : [...old, activeView]));
  }, [activeView]);
  const shown = [
    ...new Set([...retained, ...(retainedViews.includes(activeView) ? [activeView] : [])]),
  ].filter((v) => allowed.some((r) => r.id === v));
  const openReview =
    (from: WorkspaceView): OpenPaymentReview =>
    (target, element) => {
      if (!allowed.some((r) => r.id === 'payment-review-lab')) return;
      origin.current = { view: from, element, top: window.scrollY };
      setReviewDestination({ ...target, token: ++token.current });
      setReturned(false);
      setView('payment-review-lab');
    };
  function backFromReview() {
    const prior = origin.current;
    if (!prior || !allowed.some((r) => r.id === prior.view)) return;
    restore.current = prior;
    origin.current = undefined;
    setReturned(true);
    setView(prior.view);
  }
  useEffect(() => {
    const prior = restore.current;
    if (!prior || prior.view !== activeView) return;
    const frame = requestAnimationFrame(() => {
      restore.current = undefined;
      (prior.element.isConnected ? prior.element : activeNav.current)?.focus({
        preventScroll: true,
      });
      window.scrollTo({ top: prior.top, left: 0 });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeView]);
  const route = allowed.find((r) => r.id === activeView);
  return (
    <div className={`workspace ${mobile ? 'mobile-workspace' : ''}`}>
      <aside className="sidebar">
        <Brand />
        <div className="nav-label">
          {mobile ? (pickerOnly ? '拣货作业' : '仓库作业') : '运营管理'}
        </div>
        <nav aria-label="主导航">
          {allowed.map((r) => (
            <button
              key={r.id}
              ref={activeView === r.id ? activeNav : undefined}
              className={activeView === r.id ? 'nav-item active' : 'nav-item'}
              aria-current={activeView === r.id ? 'page' : undefined}
              onClick={() => navigate(r.id)}
            >
              <span aria-hidden="true">{r.glyph}</span>
              {r.name}
              {activeView === r.id && <i />}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="live-dot" /> 单小区 · 单仓服务<small>让社区生活更简单</small>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-header">
          <div className="breadcrumb">
            {mobile ? '移动作业' : '运营后台'}
            <span>/</span>
            <strong>{route?.name ?? '我的工作'}</strong>
          </div>
          <div className="user-menu">
            <span className="avatar">{profile.displayName.slice(0, 1)}</span>
            <span>{profile.displayName}</span>
            {sessionControl}
          </div>
        </header>
        <main className="workspace-main">
          <div className="page-heading">
            <div>
              <span className="eyebrow">YUMI · {mobile ? 'WORKSPACE' : 'RETAIL OPERATIONS'}</span>
              <h1>{route?.name ?? '我的工作'}</h1>
              <p>{route?.hint ?? '当前账号的配送任务将在业务开放后提供。'}</p>
            </div>
            <span className="date-note">
              {new Date().toLocaleDateString('zh-CN', {
                month: 'long',
                day: 'numeric',
                weekday: 'long',
              })}
            </span>
          </div>
          {returned && retainedViews.includes(activeView) && (
            <div className="notice" role="status">
              已返回原记录，列表与选择已保留；信息可能有更新，可刷新读取。
            </div>
          )}
          {shown.map((v) => (
            <div
              key={v}
              hidden={v !== activeView}
              className="retained-payment-view"
              data-payment-view={v}
            >
              {v === 'delivery-lab' ? (
                <DeliveryLabWorkbench profile={profile} />
              ) : v === 'picking-lab' ? (
                <PickingLabWorkbench profile={profile} />
              ) : v === 'notification-records' ? (
                <NotificationRecordsWorkbench profile={profile} onOpenReview={openReview(v)} />
              ) : v === 'payment-attempt-lab' ? (
                <PaymentAttemptLabWorkbench profile={profile} onOpenReview={openReview(v)} />
              ) : (
                <PaymentReviewLabWorkbench
                  profile={profile}
                  destination={reviewDestination}
                  active={v === activeView}
                  onReturn={origin.current ? backFromReview : undefined}
                  returnLabel={
                    origin.current?.view === 'notification-records'
                      ? '返回通知记录'
                      : '返回支付尝试'
                  }
                />
              )}
            </div>
          ))}
          {!allowed.length ? (
            <div className="surface empty-state">
              <h2>你好，{profile.displayName}</h2>
              <p>当前账号暂未开放仓库管理。配送任务开放后会在此显示。</p>
            </div>
          ) : retainedViews.includes(activeView) ? null : activeView === 'payment-adapter-lab' ? (
            <PaymentAdapterLabWorkbench profile={profile} />
          ) : activeView === 'payment-close-lab' ? (
            <PaymentCloseLabWorkbench profile={profile} />
          ) : activeView === 'notification-lab' ? (
            <NotificationLabWorkbench profile={profile} />
          ) : activeView === 'payment-readiness' ? (
            <PaymentReadinessWorkbench />
          ) : activeView === 'picking-readiness' ? (
            <PickingReadinessWorkbench />
          ) : activeView === 'orders' ? (
            <OrderWorkbench />
          ) : activeView === 'checkout-policy' ? (
            <CheckoutPolicyWorkbench profile={profile} />
          ) : activeView === 'points-grants' ? (
            <PointsGrants profile={profile} />
          ) : activeView === 'points' ? (
            <PointsWorkbench />
          ) : activeView === 'service-area' ? (
            <ServiceAreaWorkbench profile={profile} />
          ) : (
            <CatalogWorkbench
              profile={profile}
              view={activeView}
              allowedViews={allowed
                .map((r) => r.id)
                .filter(
                  (
                    id,
                  ): id is Exclude<
                    WorkspaceView,
                    | 'service-area'
                    | 'checkout-policy'
                    | 'orders'
                    | 'payment-readiness'
                    | 'notification-lab'
                    | 'notification-records'
                    | 'payment-adapter-lab'
                    | 'payment-close-lab'
                    | 'payment-attempt-lab'
                    | 'payment-review-lab'
                  > =>
                    id !== 'service-area' &&
                    id !== 'checkout-policy' &&
                    id !== 'orders' &&
                    id !== 'payment-readiness' &&
                    id !== 'notification-lab' &&
                    id !== 'notification-records' &&
                    id !== 'payment-adapter-lab' &&
                    id !== 'payment-close-lab' &&
                    id !== 'payment-attempt-lab' &&
                    id !== 'payment-review-lab',
                )}
              onNavigate={navigate}
            />
          )}
          <footer className="workspace-footer">
            玉米百货 <span>用心经营每一天</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
