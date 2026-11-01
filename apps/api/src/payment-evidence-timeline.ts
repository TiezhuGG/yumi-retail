import { Prisma } from '@yumi/database';
import type { PaymentEvidenceSource, PaymentEvidenceTimelineItem } from '@yumi/contracts';
import { failure } from './http.js';
import { uuid } from './catalog-input.js';
export const evidenceSources = ['ALL', 'ATTEMPT', 'QUERY', 'NOTIFICATION', 'NOTE'] as const;
export type EvidenceFilter = (typeof evidenceSources)[number];
export function evidenceReference(value: unknown) {
  if (typeof value !== 'string') throw failure(400, 'VALIDATION_ERROR', '证据定位参数无效');
  const parts = value.split(':');
  if (parts.length !== 2 || !evidenceSources.slice(1).includes(parts[0] as PaymentEvidenceSource))
    throw failure(400, 'VALIDATION_ERROR', '证据来源无效');
  return { source: parts[0] as PaymentEvidenceSource, id: uuid(parts[1]) };
}
const ref = (source: PaymentEvidenceSource, id: string) => source + ':' + id;
const evidence: Record<string, string> = {
  NONE: '尚无结果',
  UNKNOWN: '结果未知',
  SUCCEEDED: '合成成功证据',
  CLOSED: '合成关闭证据',
  CONFLICT: '证据冲突',
};
const states: Record<string, string> = {
  RETRY: '等待重试',
  LEASED: '租约执行中',
  DONE: '查询已停止',
  EXHAUSTED: '重试已耗尽',
  REVIEW: '等待人工核查',
};
const reasons: Record<string, string> = {
  SCHEDULED: '已安排查询',
  CLAIMED: '已领取查询任务',
  LEASE_RECOVERED: '已回收过期租约',
  RETRY_UNKNOWN: '结果未知，安排重试',
  EXHAUSTED_UNKNOWN: '结果未知，重试耗尽',
  STOPPED_KNOWN: '证据已变化，停止查询',
  EVENT_LIMIT: '证据记录已达上限',
  MANUAL_RETRY: '已重新安排查询',
  LEASE_EXHAUSTED: '租约中断次数已耗尽',
  REVIEW_REQUIRED: '查询结果要求核查',
  CLASSIFIED_KNOWN: '已记录合成已知查询结果',
  NOTIFICATION_EVIDENCE: '通知证据结算查询任务',
};
const nextLabels: Record<string, string> = {
  RETRY: '继续查单',
  REVIEW: '人工核查',
  RECONCILE: '事务核对',
};
const actions: Record<string, string> = {
  STARTED: '开始合成尝试',
  UNKNOWN_RESULT: '记录未知结果',
  SUCCESS_RESULT: '记录合成成功证据',
  CLOSED_RESULT: '记录合成关闭证据',
};
type Tx = Prisma.TransactionClient;
type Key = { id: string; source: PaymentEvidenceSource; rank: number; createdAt: Date };
/** Caller holds warehouse, attempt and task shared locks, matching all scoped writers. */
export async function paymentEvidenceTimeline(
  tx: Tx,
  w: string,
  id: string,
  filter: EvidenceFilter = 'ALL',
  cursor?: string,
  focus?: string,
) {
  const facts = Prisma.sql`
    SELECT e.id,'ATTEMPT'::text AS source,1 AS rank,e.created_at AS "createdAt" FROM payment_attempt_lab_events e JOIN payment_attempt_labs a ON a.id=e.attempt_id WHERE a.id=${id}::uuid AND a.warehouse_id=${w}::uuid
    UNION ALL SELECT e.id,'QUERY',2,e.created_at FROM payment_query_lab_events e JOIN payment_query_lab_jobs j ON j.id=e.job_id WHERE j.attempt_id=${id}::uuid AND j.warehouse_id=${w}::uuid
    UNION ALL SELECT n.id,'NOTIFICATION',3,n.created_at FROM notification_lab_records n JOIN payment_notification_lab_applications a ON a.id=n.application_id WHERE a.attempt_id=${id}::uuid AND a.warehouse_id=${w}::uuid AND n.warehouse_id=${w}::uuid
    UNION ALL SELECT n.id,'NOTE',4,n.created_at FROM payment_review_lab_notes n WHERE n.attempt_id=${id}::uuid AND n.warehouse_id=${w}::uuid`;
  let anchor: Key | undefined;
  const token = cursor ?? focus;
  if (token) {
    const r = evidenceReference(token);
    if (filter !== 'ALL' && filter !== r.source)
      throw failure(400, 'VALIDATION_ERROR', '证据定位与筛选来源不一致');
    [anchor] = await tx.$queryRaw<Key[]>(
      Prisma.sql`WITH facts AS (${facts}) SELECT * FROM facts WHERE source=${r.source} AND id=${r.id}::uuid`,
    );
    if (!anchor) throw failure(404, 'RESOURCE_NOT_FOUND', '证据不属于当前仓库和尝试，或已不可用');
  }
  const boundary = anchor
    ? Prisma.sql`AND ("createdAt",rank,id) ${focus ? Prisma.sql`<=` : Prisma.sql`<`} (${anchor.createdAt},${anchor.rank},${anchor.id}::uuid)`
    : Prisma.empty;
  const keys = await tx.$queryRaw<Key[]>(
    Prisma.sql`WITH facts AS (${facts}) SELECT * FROM facts WHERE (${filter}='ALL' OR source=${filter}) ${boundary} ORDER BY "createdAt" DESC,rank DESC,id DESC LIMIT 21`,
  );
  const page = keys.slice(0, 20),
    ids = (source: PaymentEvidenceSource) =>
      page.filter((k) => k.source === source).map((k) => k.id);
  const [attempts, queries, notifications, notes] = await Promise.all([
    tx.paymentAttemptLabEvent.findMany({
      where: { id: { in: ids('ATTEMPT') }, attemptId: id },
      select: {
        id: true,
        action: true,
        evidence: true,
        observation: true,
        version: true,
        queryEvents: { select: { id: true } },
        notificationApplication: {
          select: {
            records: {
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 1,
              select: { id: true },
            },
            _count: { select: { records: true } },
          },
        },
      },
    }),
    tx.paymentQueryLabEvent.findMany({
      where: { id: { in: ids('QUERY') }, job: { attemptId: id, warehouseId: w } },
      select: {
        id: true,
        reason: true,
        state: true,
        attempts: true,
        version: true,
        classification: true,
        resultEvidence: true,
        next: true,
        scenario: true,
        attemptEventId: true,
      },
    }),
    tx.notificationLabRecord.findMany({
      where: {
        id: { in: ids('NOTIFICATION') },
        warehouseId: w,
        application: { is: { attemptId: id } },
      },
      select: {
        id: true,
        notificationId: true,
        outTradeNo: true,
        transactionId: true,
        amountCents: true,
        currency: true,
        successTime: true,
        application: { select: { attemptEventId: true } },
      },
    }),
    tx.paymentReviewLabNote.findMany({
      where: { id: { in: ids('NOTE') }, attemptId: id, warehouseId: w },
      select: {
        id: true,
        actorName: true,
        note: true,
        evidence: true,
        attemptVersion: true,
        taskState: true,
        jobVersion: true,
      },
    }),
  ]);
  // Exact snapshot references for notes; bounded by this page, never by all historical notes.
  const [noteAttempts, noteQueries] = await Promise.all([
    tx.paymentAttemptLabEvent.findMany({
      where: { attemptId: id, version: { in: notes.map((n) => n.attemptVersion) } },
      select: { id: true, version: true },
    }),
    tx.paymentQueryLabEvent.findMany({
      where: {
        job: { attemptId: id, warehouseId: w },
        version: { in: notes.flatMap((n) => (n.jobVersion === null ? [] : [n.jobVersion])) },
      },
      select: { id: true, version: true },
    }),
  ]);
  const items: PaymentEvidenceTimelineItem[] = page.map((k) => {
    const row: PaymentEvidenceTimelineItem = {
      id: k.id,
      ref: ref(k.source, k.id),
      source: k.source,
      createdAt: k.createdAt.toISOString(),
      title: '',
      entries: [],
      related: [],
    };
    const add = (label: string, value: string | number | null) =>
      row.entries.push({ label, value: value === null ? '未记录' : String(value) });
    const link = (source: PaymentEvidenceSource, id: string, label: string) =>
      row.related.push({ ref: ref(source, id), label });
    if (k.source === 'ATTEMPT') {
      const a = attempts.find((a) => a.id === k.id)!;
      row.title = actions[a.action] ?? a.action;
      add('尝试记录序号', a.version);
      add('本次观察', evidence[a.observation] ?? a.observation);
      add('合并后证据', evidence[a.evidence] ?? a.evidence);
      if (a.queryEvents[0]) link('QUERY', a.queryEvents[0].id, '定位关联查询记录');
      const app = a.notificationApplication;
      if (app) {
        add('同交易通知记录数', app._count.records);
        if (app.records[0]) link('NOTIFICATION', app.records[0].id, '定位最新关联通知');
      }
    } else if (k.source === 'QUERY') {
      const q = queries.find((q) => q.id === k.id)!;
      row.title = reasons[q.reason] ?? q.reason;
      add('任务记录序号', q.version);
      add('任务状态', states[q.state] ?? q.state);
      add('本轮领取次数', q.attempts);
      add('查询分类', q.classification);
      add('固定合成场景', q.scenario);
      add('查询证据', q.resultEvidence ? (evidence[q.resultEvidence] ?? q.resultEvidence) : null);
      add('处理建议', q.next ? (nextLabels[q.next] ?? q.next) : null);
      if (q.attemptEventId) link('ATTEMPT', q.attemptEventId, '定位关联尝试证据');
    } else if (k.source === 'NOTIFICATION') {
      const n = notifications.find((n) => n.id === k.id)!;
      row.title = '保存合成通知';
      add('通知标识', n.notificationId);
      add('合成商户单号', n.outTradeNo);
      add('合成交易标识', n.transactionId);
      add('固定测试金额', '¥' + (Number(n.amountCents) / 100).toFixed(2) + ' ' + n.currency);
      add('合成报文成功时间', n.successTime);
      if (n.application) link('ATTEMPT', n.application.attemptEventId, '定位共享成功证据');
    } else {
      const n = notes.find((n) => n.id === k.id)!;
      row.title = '追加核查备注';
      add('核查人', n.actorName);
      add('核查备注', n.note);
      add('当时证据', evidence[n.evidence] ?? n.evidence);
      add('当时尝试记录序号', n.attemptVersion);
      add('当时任务状态', n.taskState ? (states[n.taskState] ?? n.taskState) : null);
      add('当时任务记录序号', n.jobVersion);
      const a = noteAttempts.find((a) => a.version === n.attemptVersion),
        q = noteQueries.find((q) => q.version === n.jobVersion);
      if (a) link('ATTEMPT', a.id, '定位备注快照的尝试证据');
      if (q) link('QUERY', q.id, '定位备注快照的查询记录');
    }
    return row;
  });
  return {
    items,
    nextCursor: keys.length > 20 ? ref(page[19]!.source, page[19]!.id) : null,
    filter,
    focusedRef: focus && anchor ? ref(anchor.source, anchor.id) : null,
    syntheticOnly: true as const,
  };
}
