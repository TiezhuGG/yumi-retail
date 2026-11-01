import { useState } from 'react';
import type { PickingLabTask, StaffProfile } from '@yumi/contracts';
import type { Operation } from './picking-lab.js';
export function PickingPackingPanel({
  task,
  profile,
  disabled,
  onExecute,
}: {
  task: PickingLabTask;
  profile: StaffProfile;
  disabled: boolean;
  onExecute: (op: Operation) => Promise<void>;
}) {
  const [single, setSingle] = useState(''),
    [triple, setTriple] = useState(''),
    [packages, setPackages] = useState('1');
  const body = {
    key: crypto.randomUUID(),
    version: task.version,
    exceptionVersion: task.exceptionVersion,
  };
  const time = (v: string) =>
    new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  return (
    <section className="readiness-check picking-packing" aria-label="合成打包与出库">
      <h3>合成打包与出库</h3>
      <p>演练凭据只记录完整性核验；不扣真实库存、不生成骑手任务。</p>
      {!task.pack ? (
        <>
          <p>
            {task.packingReadiness.ready
              ? '两行均已核对，且无未决缺货，可由领取人确认合成打包。'
              : '尚不满足打包条件：请先完成全部明细核对并处理未决缺货。'}
          </p>
          {task.ownerId === profile.id && profile.permissions.includes('picking-lab.work') ? (
            <form
              className="picking-check-form"
              onSubmit={(e) => {
                e.preventDefault();
                void onExecute({
                  path: '/warehouse/picking-lab/' + task.id + '/pack',
                  body: {
                    ...body,
                    packageCount: Number(packages),
                    singleQuantity: Number(single),
                    tripleQuantity: Number(triple),
                  },
                  label: '合成打包',
                });
              }}
            >
              <label>
                单包装装包数量
                <input
                  aria-label="单包装装包数量"
                  type="number"
                  min="0"
                  max="200"
                  step="1"
                  required
                  value={single}
                  onChange={(e) => setSingle(e.target.value)}
                  disabled={disabled || !task.packingReadiness.ready}
                />
              </label>
              <label>
                3包装装包数量
                <input
                  aria-label="3包装装包数量"
                  type="number"
                  min="0"
                  max="200"
                  step="1"
                  required
                  value={triple}
                  onChange={(e) => setTriple(e.target.value)}
                  disabled={disabled || !task.packingReadiness.ready}
                />
              </label>
              <label>
                合成包裹数
                <input
                  aria-label="合成包裹数"
                  type="number"
                  min="1"
                  max="20"
                  step="1"
                  required
                  value={packages}
                  onChange={(e) => setPackages(e.target.value)}
                  disabled={disabled || !task.packingReadiness.ready}
                />
              </label>
              <p>请逐行复核：单包装 2 包、3包装 1 组。包裹数 1–20 仅为演练保护范围。</p>
              <button
                className="primary-button"
                disabled={disabled || !task.packingReadiness.ready}
              >
                确认合成打包
              </button>
            </form>
          ) : (
            <p>仅领取人可确认合成打包。</p>
          )}
        </>
      ) : (
        <>
          <span className="badge green">合成打包已记录</span>
          <p>
            单包装 {task.pack.singleQuantity} 包 · 3包装 {task.pack.tripleQuantity} 组 · 共{' '}
            {task.pack.packageCount} 个合成包裹
          </p>
          <p>
            打包人：{task.pack.actorName} · {time(task.pack.createdAt)}
          </p>
          {task.pack.dispatch ? (
            <>
              <span className="badge green">合成出库已记录</span>
              <p>
                确认人：{task.pack.dispatch.actorName} · {time(task.pack.dispatch.createdAt)}
              </p>
              <p>本任务已完成隔离演练，凭据不可修改；尚未进行真实出库或骑手交接。</p>
            </>
          ) : (
            <>
              <p>待负责人或仓管确认一次合成出库。</p>
              {profile.permissions.includes('picking-lab.ship') && (
                <button
                  className="primary-button"
                  disabled={disabled}
                  onClick={() =>
                    void onExecute({
                      path: '/warehouse/picking-lab/' + task.id + '/dispatch',
                      body: { ...body, packId: task.pack!.id },
                      label: '合成出库',
                    })
                  }
                >
                  确认合成出库
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
