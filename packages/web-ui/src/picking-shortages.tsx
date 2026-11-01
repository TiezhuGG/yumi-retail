import { useEffect, useState } from 'react';
import type { PickingLabTask, StaffProfile } from '@yumi/contracts';
import type { Operation } from './picking-lab.js';
export function PickingShortagesPanel({
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
  const [amounts, setAmounts] = useState<Record<string, string>>({}),
    [reasons, setReasons] = useState<Record<string, string>>({});
  useEffect(() => {
    setAmounts({});
    setReasons({});
  }, [task.id, task.exceptionVersion]);
  const open = task.shortages.filter((s) => s.state === 'OPEN');
  return (
    <section className="picking-shortages" aria-label="合成缺货与阻断">
      <div className="service-area-list-heading">
        <h3>合成缺货与阻断</h3>
        <span className={'badge ' + (open.length ? 'amber' : 'green')}>未决 {open.length} 条</span>
      </div>
      {open.length > 0 ? (
        <div className="notice task-error" role="status">
          有未决缺货记录，整项演练暂停核对。不能以部分数量、备注或刷新解除阻断。
        </div>
      ) : (
        <p>暂无未决合成缺货。缺货已消除后仍需领取人按原需求重新核对。</p>
      )}
      <p>
        仅记录合成缺货/破损；不释放真实预占、不退款、不少发、不出库。仓管确认原需求全部备齐后才能恢复。
      </p>
      {task.state === 'PICKING' &&
        task.ownerId === profile.id &&
        profile.permissions.includes('picking-lab.work') &&
        task.lines
          .filter((l) => !l.checked && !open.some((s) => s.lineId === l.id))
          .map((line) => (
            <details className="shortage-report" key={line.id}>
              <summary>上报{line.spec}合成缺货</summary>
              <form
                className="picking-check-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onExecute({
                    path: '/warehouse/picking-lab/' + task.id + '/shortages',
                    body: {
                      key: crypto.randomUUID(),
                      version: task.version,
                      exceptionVersion: task.exceptionVersion,
                      lineId: line.id,
                      missingQuantity: Number(amounts[line.id]),
                      reason: reasons[line.id] ?? 'MISSING',
                    },
                    label: line.spec + '合成缺货上报',
                  });
                }}
              >
                <label>
                  缺货数量
                  <input
                    aria-label={line.spec + '合成缺货数量'}
                    type="number"
                    min="1"
                    max={line.required}
                    step="1"
                    required
                    disabled={disabled}
                    value={amounts[line.id] ?? ''}
                    onChange={(e) => setAmounts({ ...amounts, [line.id]: e.target.value })}
                  />
                </label>
                <label>
                  原因
                  <select
                    aria-label={line.spec + '合成缺货原因'}
                    disabled={disabled}
                    value={reasons[line.id] ?? 'MISSING'}
                    onChange={(e) => setReasons({ ...reasons, [line.id]: e.target.value })}
                  >
                    <option value="MISSING">合成缺货</option>
                    <option value="DAMAGED">合成破损</option>
                  </select>
                </label>
                <button className="secondary-button" type="submit" disabled={disabled}>
                  提交{line.spec}缺货
                </button>
              </form>
            </details>
          ))}
      {task.shortages.map((s) => {
        const line = task.lines.find((l) => l.id === s.lineId)!;
        return (
          <article className="picking-line" key={s.id}>
            <h4>
              {line.name} · {line.spec} · {s.reason === 'DAMAGED' ? '合成破损' : '合成缺货'}
            </h4>
            <span className={'badge ' + (s.state === 'OPEN' ? 'amber' : 'green')}>
              {s.state === 'OPEN' ? '待处理，阻断核对' : '合成缺货已消除'}
            </span>
            <p>
              上报缺货 {s.missingQuantity} {line.unit} · 原需求 {line.required} {line.unit}
            </p>
            {s.state === 'OPEN' && profile.permissions.includes('picking-lab.resolve') && (
              <form
                className="picking-check-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onExecute({
                    path: '/warehouse/picking-lab/' + task.id + '/shortages/' + s.id + '/restore',
                    body: {
                      key: crypto.randomUUID(),
                      version: task.version,
                      exceptionVersion: task.exceptionVersion,
                      shortageVersion: s.version,
                      confirmedQuantity: Number(amounts[s.id]),
                    },
                    label: line.spec + '合成备齐确认',
                  });
                }}
              >
                <label>
                  确认原需求备齐数量
                  <input
                    aria-label={line.spec + '备齐确认数量'}
                    type="number"
                    min="1"
                    max={line.required}
                    step="1"
                    required
                    disabled={disabled}
                    value={amounts[s.id] ?? ''}
                    onChange={(e) => setAmounts({ ...amounts, [s.id]: e.target.value })}
                  />
                </label>
                <button className="secondary-button" type="submit" disabled={disabled}>
                  确认{line.spec}已备齐
                </button>
              </form>
            )}
            {s.state === 'OPEN' && !profile.permissions.includes('picking-lab.resolve') && (
              <p>等待负责人或仓管确认合成缺货消除；拣货员不能自行解除。</p>
            )}
            <ol>
              {s.events.map((e, i) => (
                <li key={i}>
                  {e.action === 'REPORT' ? '上报合成缺货' : '确认原需求备齐'} · {e.actorName} ·{' '}
                  {e.quantity} {line.unit} ·{' '}
                  {new Date(e.createdAt).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    hour12: false,
                  })}
                </li>
              ))}
            </ol>
          </article>
        );
      })}
    </section>
  );
}
