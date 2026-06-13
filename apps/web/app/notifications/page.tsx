import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import {
  Bell,
  CalendarClock,
  CheckCircle2,
  CircleSlash,
  Clock3,
  DownloadCloud,
  Film,
  Layers,
  PartyPopper,
  TriangleAlert,
} from "lucide-react";
import type { NotificationEvent, NotificationReport, NotificationReportStatus } from "@media-track/workflow";
import { AppSidebar } from "../../components/app-sidebar";
import { ensureDemoSeeded, getWorkflowRepository } from "../../lib/workflow-runtime";

const kindMeta: Record<string, { label: string; tone: string; icon: typeof Bell }> = {
  series_initialized: { label: "全剧入库", tone: "green", icon: Layers },
  package_initialized: { label: "电影入库", tone: "green", icon: Film },
  tracking_initialized: { label: "开始追踪", tone: "indigo", icon: DownloadCloud },
  episodes_restored: { label: "更新获取", tone: "indigo", icon: DownloadCloud },
  tracking_completed: { label: "追踪完成", tone: "green", icon: PartyPopper },
  already_current: { label: "已是最新", tone: "muted", icon: CheckCircle2 },
  no_coverage: { label: "暂无资源", tone: "amber", icon: CircleSlash },
  foreign_work_detected: { label: "待确认入库", tone: "amber", icon: Film },
};

const statusMeta: Record<NotificationReportStatus, { label: string; tone: string; icon: typeof Bell }> = {
  complete: { label: "已完结", tone: "green", icon: CheckCircle2 },
  acquired: { label: "已入库", tone: "green", icon: CheckCircle2 },
  airing: { label: "追更中", tone: "indigo", icon: Clock3 },
  partial: { label: "有缺集", tone: "amber", icon: TriangleAlert },
  no_coverage: { label: "暂无资源", tone: "amber", icon: CircleSlash },
};

export default function NotificationsPage() {
  return (
    <div className="app-shell">
      <AppSidebar active="notifications" />
      <main className="main product-main">
        <div className="section-heading library-heading">
          <div>
            <h1>通知</h1>
            <p>每天的资源获取与追踪日报</p>
          </div>
        </div>
        <Suspense fallback={<FeedSkeleton />}>
          <NotificationFeed />
        </Suspense>
      </main>
    </div>
  );
}

async function NotificationFeed() {
  // SQLite reads + "today/yesterday" labels are request-time work; declare it
  // so the PPR shell stays static and this hole streams per request.
  await connection();
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const notifications = await repository.listNotifications({ limit: 100 });

  if (notifications.length === 0) {
    return (
      <div className="quiet-state">
        <Bell size={24} aria-hidden />
        <strong>还没有任何记录</strong>
        <span>发起获取或等待例行检查后，这里会按日期展示结果。</span>
      </div>
    );
  }

  const groups = groupByDay(notifications);
  return (
    <section className="feed">
      {groups.map((group) => {
        // A scheduled sweep covers many shows at once → one daily digest.
        // User-triggered acquisitions are one-resource events → one card each.
        const userEvents = group.items.filter((item) => item.trigger !== "scheduled");
        const scheduledEvents = group.items.filter((item) => item.trigger === "scheduled");
        return (
          <section className="feed-day" key={group.dateKey}>
            <header className="feed-day-header">
              <span className="feed-day-label">{group.dayLabel}</span>
              <span className="feed-day-summary">{daySummary(group.items)}</span>
            </header>
            <ul className="feed-list">
              {userEvents.map((item) => (
                <NotificationCard notification={item} key={item.id} />
              ))}
            </ul>
            {scheduledEvents.length > 0 ? <DailyRoutineDigest items={scheduledEvents} /> : null}
          </section>
        );
      })}
    </section>
  );
}

function NotificationCard({ notification }: { notification: NotificationEvent }) {
  const meta = kindMeta[notification.kind] ?? { label: notification.kind, tone: "muted", icon: Bell };
  const KindIcon = meta.icon;
  const report = notification.report;

  // Legacy / report-less events (foreign work, old records): minimal rendering.
  if (!report) {
    return (
      <li className="feed-item">
        <span className={`feed-icon tone-${meta.tone}`}>
          <KindIcon size={15} aria-hidden />
        </span>
        <span className="feed-body">
          <span className="feed-title-row">
            <strong>{notification.title}</strong>
            <span className={`feed-badge tone-${meta.tone}`}>{meta.label}</span>
          </span>
          <span className="feed-text">{notification.body}</span>
          {notification.kind === "foreign_work_detected" ? (
            <Link
              className="feed-action"
              href={`/foreign-work/${encodeURIComponent(notification.workflowRunId)}`}
            >
              去处理 →
            </Link>
          ) : null}
        </span>
        <time className="feed-time" dateTime={notification.createdAt}>
          {timeLabel(notification.createdAt)}
        </time>
      </li>
    );
  }

  const status = statusMeta[report.status];
  const StatusIcon = status.icon;
  const [firstLine, ...restLines] = report.lines;
  const heading = report.seasonLabel ? `${report.titleName} ${report.seasonLabel}` : report.titleName;

  return (
    <li className="feed-item">
      <span className={`feed-icon tone-${meta.tone}`}>
        <KindIcon size={15} aria-hidden />
      </span>
      <span className="feed-body">
        <span className="feed-title-row">
          <strong>{heading}</strong>
          <span className={`feed-badge tone-${meta.tone}`}>{meta.label}</span>
        </span>
        <span className="feed-report">
          <span className="feed-progress">
            <span className={`feed-status-pill tone-${status.tone}`}>
              <StatusIcon size={11} aria-hidden />
              {status.label}
            </span>
            {firstLine ? <span className="feed-progress-text">{firstLine}</span> : null}
          </span>
          {restLines.map((line) => (
            <span className="feed-report-line" key={line}>
              {line}
            </span>
          ))}
          <ChipGroup label="本次新增" codes={report.newlyObtained} variant="is-new" />
          <ChipGroup label="缺集" codes={report.realMissing} variant="is-missing" />
        </span>
      </span>
      <time className="feed-time" dateTime={notification.createdAt}>
        {timeLabel(notification.createdAt)}
      </time>
    </li>
  );
}

function ChipGroup({ label, codes, variant }: { label: string; codes: string[]; variant: string }) {
  if (codes.length === 0) {
    return null;
  }
  return (
    <span className="feed-chip-group">
      <span className="feed-chip-label">{label}</span>
      <span className="feed-chips">
        {codes.map((code) => (
          <span className={`feed-chip ${variant}`} key={code}>
            {code}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * The scheduled sweep touches many tracked shows at once, so it reads as a
 * single daily-routine digest rather than one card per show: shows that
 * changed get a detail row; shows checked with nothing to do collapse into a
 * tail count.
 */
function DailyRoutineDigest({ items }: { items: NotificationEvent[] }) {
  const changed = items.filter((item) => item.kind !== "already_current");
  const unchanged = items.length - changed.length;
  const latest = items.reduce((max, item) => (item.createdAt > max ? item.createdAt : max), items[0]!.createdAt);

  return (
    <div className="routine-digest">
      <div className="routine-head">
        <span className="feed-icon tone-indigo">
          <CalendarClock size={15} aria-hidden />
        </span>
        <span className="routine-title">每日巡检</span>
        <span className="feed-badge tone-indigo">{changed.length > 0 ? `${changed.length} 部更新` : "无更新"}</span>
        <time className="feed-time routine-time" dateTime={latest}>
          {timeLabel(latest)}
        </time>
      </div>

      {changed.length > 0 ? (
        <ul className="routine-rows">
          {changed.map((item) => (
            <DigestRow notification={item} key={item.id} />
          ))}
        </ul>
      ) : null}

      <p className="routine-tail">
        {changed.length === 0
          ? "已检查全部追踪剧集，已播出集数均已获取。"
          : unchanged > 0
            ? `其余 ${unchanged} 部追踪剧集已是最新。`
            : "全部追踪剧集已检查。"}
      </p>
    </div>
  );
}

function DigestRow({ notification }: { notification: NotificationEvent }) {
  const report = notification.report;
  const heading = report
    ? report.seasonLabel
      ? `${report.titleName} ${report.seasonLabel}`
      : report.titleName
    : notification.title;
  const finale = notification.kind === "tracking_completed";

  return (
    <li className="routine-row">
      <span className={`routine-dot ${finale ? "is-finale" : ""}`} aria-hidden />
      <span className="routine-row-body">
        <span className="routine-row-title">
          {heading}
          {finale ? <PartyPopper size={12} aria-hidden className="routine-finale-icon" /> : null}
        </span>
        {report ? (
          <span className="routine-row-meta">
            {report.newlyObtained.length > 0 ? (
              <span className="routine-chips">
                本次新增
                {report.newlyObtained.map((code) => (
                  <span className="feed-chip is-new" key={code}>
                    {code}
                  </span>
                ))}
              </span>
            ) : null}
            {report.realMissing.length > 0 ? (
              <span className="routine-chips">
                缺集
                {report.realMissing.map((code) => (
                  <span className="feed-chip is-missing" key={code}>
                    {code}
                  </span>
                ))}
              </span>
            ) : null}
            {finale ? <span className="routine-finale-text">{report.lines[0]}</span> : null}
          </span>
        ) : (
          <span className="routine-row-meta">{notification.body}</span>
        )}
      </span>
    </li>
  );
}

function groupByDay(notifications: NotificationEvent[]) {
  const groups = new Map<string, NotificationEvent[]>();
  for (const notification of notifications) {
    const key = dateKey(notification.createdAt);
    const list = groups.get(key) ?? [];
    list.push(notification);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, items]) => ({
    dateKey: key,
    dayLabel: dayLabel(key),
    items,
  }));
}

function dateKey(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function dayLabel(key: string): string {
  const today = dateKey(new Date().toISOString());
  const yesterday = dateKey(new Date(Date.now() - 86_400_000).toISOString());
  if (key === today) return "今天";
  if (key === yesterday) return "昨天";
  const [year, month, day] = key.split("-");
  const thisYear = today.split("-")[0];
  return year === thisYear ? `${Number(month)}月${Number(day)}日` : `${year}年${Number(month)}月${Number(day)}日`;
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function daySummary(items: NotificationEvent[]): string {
  const newly = items.reduce((sum, item) => sum + (item.report?.newlyObtained.length ?? 0), 0);
  const noCoverage = items.filter((item) => item.kind === "no_coverage").length;
  const parts = [`${items.length} 条记录`];
  if (newly > 0) parts.push(`${newly} 集新增`);
  if (noCoverage > 0) parts.push(`${noCoverage} 项暂无资源`);
  return parts.join(" · ");
}

function FeedSkeleton() {
  return (
    <section className="feed">
      <div className="skeleton skeleton-heading" />
      <div className="skeleton skeleton-metric" />
      <div className="skeleton skeleton-metric" />
      <div className="skeleton skeleton-metric" />
    </section>
  );
}
