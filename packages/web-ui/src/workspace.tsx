import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { StaffProfile } from '@yumi/contracts';
import { CatalogWorkbench } from './catalog.js';
import { Brand } from './brand.js';
export type WorkspaceView =
  | 'overview'
  | 'products'
  | 'categories'
  | 'receipts'
  | 'stock'
  | 'locations'
  | 'counts'
  | 'dispositions'
  | 'reversals';
const routes: Array<{
  id: WorkspaceView;
  name: string;
  glyph: string;
  hint: string;
  permission: string;
}> = [
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
export function Workspace({
  profile,
  sessionControl,
  mobile = false,
}: {
  profile: StaffProfile;
  sessionControl: ReactNode;
  mobile?: boolean;
}) {
  const allowed = routes.filter((r) => profile.permissions.includes(r.permission));
  const [view, setView] = useState<WorkspaceView>(allowed[0]?.id ?? 'overview');
  const activeNav = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const reveal = () => activeNav.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
    reveal();
    const mobileWidth = window.matchMedia('(max-width: 680px)');
    mobileWidth.addEventListener('change', reveal);
    return () => mobileWidth.removeEventListener('change', reveal);
  }, [view]);
  const route = allowed.find((r) => r.id === view);
  return (
    <div className={`workspace ${mobile ? 'mobile-workspace' : ''}`}>
      <aside className="sidebar">
        <Brand />
        <div className="nav-label">{mobile ? '仓库作业' : '运营管理'}</div>
        <nav aria-label="主导航">
          {allowed.map((r) => (
            <button
              key={r.id}
              ref={view === r.id ? activeNav : undefined}
              className={view === r.id ? 'nav-item active' : 'nav-item'}
              aria-current={view === r.id ? 'page' : undefined}
              onClick={() => setView(r.id)}
            >
              <span aria-hidden="true">{r.glyph}</span>
              {r.name}
              {view === r.id && <i />}
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
          {!allowed.length ? (
            <div className="surface empty-state">
              <h2>你好，{profile.displayName}</h2>
              <p>当前账号暂未开放仓库管理。配送任务开放后会在此显示。</p>
            </div>
          ) : (
            <CatalogWorkbench profile={profile} view={view} onNavigate={setView} />
          )}
          <footer className="workspace-footer">
            玉米百货 <span>用心经营每一天</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
