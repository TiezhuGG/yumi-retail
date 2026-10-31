import { useEffect, useRef, useState } from 'react';
import type { ServiceAreaDetail, ServiceBuilding, StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';
export function ServiceAreaWorkbench({ profile }: { profile: StaffProfile }) {
  const [area, setArea] = useState<ServiceAreaDetail | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [filter, setFilter] = useState('');
  const [editor, setEditor] = useState<{
    kind: 'area' | 'building';
    building?: ServiceBuilding;
    create: boolean;
  } | null>(null);
  const sequence = useRef(0);
  const writable = profile.permissions.includes('service-area.write');
  async function load() {
    const current = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const result = await staffRequest<{ area: ServiceAreaDetail | null }>('/admin/service-area');
      if (current === sequence.current) setArea(result.area);
    } catch (e) {
      if (current === sequence.current) setError(e instanceof Error ? e.message : '范围加载失败');
      throw e;
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load().catch(() => {});
    return () => {
      sequence.current++;
    };
  }, []);
  const rows =
    area?.buildings.filter((b) => b.name.toLowerCase().includes(filter.trim().toLowerCase())) ?? [];
  return (
    <div className="service-area-workbench">
      <div className="notice">
        首版仅服务一个小区。这里维护楼栋白名单，不代表已验证真实配送范围或已开放下单；真实小区资料尚待负责人提供。
      </div>
      <div className="service-area-toolbar">
        <button
          className="secondary-button"
          disabled={loading}
          onClick={() => void load().catch(() => {})}
        >
          {loading ? '正在读取…' : '刷新范围'}
        </button>
      </div>
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button className="secondary-button" onClick={() => void load().catch(() => {})}>
            重试读取
          </button>
        </div>
      )}
      {loading && !area ? (
        <div className="surface empty-state" role="status">
          正在读取小区与楼栋…
        </div>
      ) : !area && !error ? (
        <div className="surface empty-state">
          <h2>尚未配置服务小区</h2>
          <p>录入真实小区名称后，逐栋核对配送范围。新建默认停用。</p>
          {writable && (
            <button
              className="primary-button"
              onClick={() => setEditor({ kind: 'area', create: true })}
            >
              建立服务小区
            </button>
          )}
        </div>
      ) : (
        area && (
          <>
            <section className="surface service-area-summary">
              <div>
                <span className="eyebrow">SERVICE COMMUNITY</span>
                <h2>{area.name}</h2>
                <p>经营仓库：{area.warehouse.name}</p>
                <span className={`status-badge ${area.enabled ? 'good' : 'muted'}`}>
                  {area.enabled ? '小区已启用' : '小区已停用'}
                </span>
              </div>
              <div>
                <strong>
                  {area.buildings.filter((b) => b.enabled).length} / {area.buildings.length}
                </strong>
                <p>启用楼栋 / 已维护楼栋</p>
                {writable && (
                  <button
                    className="secondary-button"
                    disabled={loading}
                    onClick={() => setEditor({ kind: 'area', create: false })}
                  >
                    编辑小区与启停
                  </button>
                )}
              </div>
            </section>
            <section className="surface">
              <div className="service-area-list-heading">
                <div>
                  <h2>服务楼栋</h2>
                  <p>
                    {area.enabled
                      ? '仅启用楼栋会展示给顾客。'
                      : '小区停用期间，全部楼栋都不向顾客开放；楼栋自身状态保留。'}
                  </p>
                </div>
                {writable && (
                  <button
                    className="primary-button"
                    disabled={loading}
                    onClick={() => setEditor({ kind: 'building', create: true })}
                  >
                    新增楼栋
                  </button>
                )}
              </div>
              <label className="service-area-search">
                查找楼栋
                <input
                  value={filter}
                  maxLength={80}
                  placeholder="输入楼栋名称"
                  onChange={(e) => setFilter(e.target.value)}
                />
              </label>
              <div className="service-building-list">
                {rows.map((b) => (
                  <article key={b.id}>
                    <div className="service-building-icon">⌂</div>
                    <div>
                      <h3>{b.name}</h3>
                      <p>
                        {b.enabled
                          ? area.enabled
                            ? '当前有效服务楼栋'
                            : '已启用 · 小区暂停中'
                          : '楼栋已停用'}
                      </p>
                    </div>
                    {writable && (
                      <button
                        className="secondary-button"
                        disabled={loading}
                        onClick={() => setEditor({ kind: 'building', building: b, create: false })}
                      >
                        编辑
                      </button>
                    )}
                  </article>
                ))}
              </div>
              {!rows.length && (
                <p className="empty-state">
                  {filter ? '没有匹配楼栋，请调整搜索条件。' : '尚未添加楼栋，新建楼栋默认停用。'}
                </p>
              )}
            </section>
          </>
        )
      )}
      {editor && (
        <AreaEditor
          profile={profile}
          area={area}
          editor={editor}
          onClose={() => {
            setEditor(null);
            void load().catch(() => {});
          }}
          onSaved={async () => {
            setEditor(null);
            await load();
          }}
        />
      )}
    </div>
  );
}
function AreaEditor({
  profile,
  area,
  editor,
  onClose,
  onSaved,
}: {
  profile: StaffProfile;
  area: ServiceAreaDetail | null;
  editor: { kind: 'area' | 'building'; building?: ServiceBuilding; create: boolean };
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(
      editor.create ? '' : editor.kind === 'area' ? area!.name : editor.building!.name,
    ),
    [enabled, setEnabled] = useState(
      editor.kind === 'area' ? (area?.enabled ?? false) : (editor.building?.enabled ?? false),
    );
  const [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [conflict, setConflict] = useState(false),
    [error, setError] = useState('');
  const intent = useRef<{ path: string; body: unknown; key: string } | null>(null),
    saving = useRef(false);
  async function save() {
    if (saving.current || conflict) return;
    saving.current = true;
    setBusy(true);
    setError('');
    const attempt = intent.current ?? {
      path:
        editor.kind === 'area'
          ? editor.create
            ? '/admin/service-area'
            : '/admin/service-area/update'
          : editor.create
            ? '/admin/service-area/buildings'
            : `/admin/service-area/buildings/${editor.building!.id}/update`,
      body: editor.create
        ? { name: name.trim(), ...(editor.kind === 'building' ? { version: area!.version } : {}) }
        : { name: name.trim(), enabled, version: area!.version },
      key: crypto.randomUUID(),
    };
    intent.current = attempt;
    try {
      await staffRequest(attempt.path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': attempt.key,
        },
        body: JSON.stringify(attempt.body),
      });
      await onSaved().catch(() => {});
    } catch (e) {
      if (e instanceof StaffRequestError && e.status < 500) {
        intent.current = null;
        setUnknown(false);
        setConflict(
          e.status === 409 && ['VERSION_CONFLICT', 'SERVICE_AREA_EXISTS'].includes(e.code ?? ''),
        );
        setError(e.message);
      } else {
        setUnknown(true);
        setError('保存结果尚未确认，原内容已冻结。请使用原操作重试确认。');
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        editor.kind === 'area'
          ? editor.create
            ? '建立服务小区'
            : '编辑服务小区'
          : editor.create
            ? '新增服务楼栋'
            : '编辑服务楼栋'
      }
      busy={busy || unknown}
      onClose={onClose}
    >
      <form
        className="service-area-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="notice">
          {editor.create
            ? '新建后默认停用，请核对真实范围后再启用。'
            : '停用会立即从公开配送范围移除，不会删除楼栋资料。'}
        </p>
        {error && (
          <p className="notice task-error" role="alert">
            {error}
          </p>
        )}
        <label>
          {editor.kind === 'area' ? '小区名称' : '楼栋名称'}
          <input
            autoFocus
            required
            maxLength={editor.kind === 'area' ? 100 : 80}
            value={name}
            disabled={busy || unknown || conflict}
            onChange={(e) => setName(e.target.value)}
            placeholder={editor.kind === 'area' ? '请输入实际服务小区' : '如：1栋、东区A座'}
          />
        </label>
        {!editor.create && (
          <label className="service-area-check">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy || unknown || conflict}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            启用{editor.kind === 'area' ? '小区' : '楼栋'}
          </label>
        )}
        {!editor.create && enabled && (
          <p className="service-area-help">
            启用表示此配置可向顾客公开展示，请先核对实际可服务范围；不代表当前已开放结算。
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy || unknown}
            onClick={onClose}
          >
            {conflict ? '关闭后刷新范围' : '取消'}
          </button>
          <button className="primary-button" disabled={busy || conflict || !name.trim()}>
            {busy ? '正在保存…' : unknown ? '原操作重试确认' : '保存配置'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
