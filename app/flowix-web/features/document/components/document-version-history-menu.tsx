import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { ClockIcon, CloudArrowUpIcon } from '@phosphor-icons/react';
import { fns as fnsClient, notes as notesClient, type FnsCloudVersionMeta, type PathVersionMeta } from '@platform/tauri/client';
import { useI18n, translate, type AppLanguage, type I18nKey } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { Dialog, DialogContent, DialogTitle } from '@shared/ui/dialog';
import { useMobileBackInterceptor } from '@features/shell/hooks/use-mobile-back-button';

type VersionDisplay = PathVersionMeta;
const logger = createLogger('document-version-history');

const VERSION_SOURCE_LABEL_KEYS: Record<PathVersionMeta['source'], I18nKey> = {
  auto: "document.version.source.auto",
  manual: "document.version.source.manual",
  restore_backup: "document.version.source.restoreBackup",
  cloud_conflict: "document.version.source.cloudConflict",
};

export function formatVersionTime(timestamp: number, language: AppLanguage): string {
  const intlLocale = language === "zh-CN" ? "zh-CN" : "en-US";
  // 英文用「June 24, 2025」简写形式 (long month + day + year, 无时间); 中文保留
  // 紧凑数字格式带时分, 列表项之间的时间信息更密。
  const options: Intl.DateTimeFormatOptions =
    language === "zh-CN"
      ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
      : { year: "numeric", month: "long", day: "numeric" };
  return new Intl.DateTimeFormat(intlLocale, options).format(new Date(timestamp));
}

function formatVersionSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** `enabled` 期间加载版本列表; requestSeq 防止过期响应回写。子菜单与移动端弹窗共用。 */
function useVersionHistoryList(
  notebookId: string,
  relativePath: string,
  refreshKey: number,
  enabled: boolean,
) {
  const { t } = useI18n();
  const [versions, setVersions] = useState<VersionDisplay[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    setFailed(false);

    void notesClient.listVersions(notebookId, relativePath)
      .then((items) => {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
        setVersions(items);
      })
      .catch((err) => {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
        logger.error('list versions failed', { error: err, notebookId, relativePath });
        setFailed(true);
        toast.error(t("document.version.loadFailed"));
      })
      .finally(() => {
        if (mountedRef.current && requestSeqRef.current === requestSeq) {
          setLoading(false);
        }
      });
  }, [enabled, notebookId, relativePath, refreshKey, t]);

  const orderedVersions = useMemo(
    () => [...versions].sort((a, b) => b.createdAt - a.createdAt),
    [versions],
  );

  return { versions: orderedVersions, loading, failed };
}

function VersionListItem({
  version,
  relativePath,
  restoringVersionId,
  onSelect,
}: {
  version: VersionDisplay;
  relativePath: string;
  restoringVersionId: string | null;
  onSelect: (version: VersionDisplay) => void;
}) {
  const { language } = useI18n();
  const isRestoring = restoringVersionId === version.id;
  return (
    <button
      key={version.id}
      type="button"
      disabled={isRestoring}
      onClick={() => onSelect(version)}
      className="group block w-full rounded-lg px-2 py-2 text-left hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-60"
      title={relativePath}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--foreground)] group-hover:text-[var(--foreground)]">
          {formatVersionTime(version.createdAt, language)}
        </span>
        {isRestoring && (
          <Loader2 className="h-3 w-3 flowix-spin text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]" />
        )}
        <span className="rounded bg-[var(--background)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)] group-hover:bg-[var(--card)] group-hover:text-[var(--foreground)]">
          {translate(language, VERSION_SOURCE_LABEL_KEYS[version.source] ?? "") || version.source}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]">
        <span className="min-w-0 flex-1 truncate group-hover:text-[var(--foreground)]">
          {relativePath}
        </span>
        <span className="shrink-0">{formatVersionSize(version.size)}</span>
      </div>
    </button>
  );
}

function VersionListBody({
  loading,
  failed,
  versions,
  relativePath,
  restoringVersionId,
  onSelect,
}: {
  loading: boolean;
  failed: boolean;
  versions: VersionDisplay[];
  relativePath: string;
  restoringVersionId: string | null;
  onSelect: (version: VersionDisplay) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {loading && (
        <div className="flex items-center gap-1 px-2 py-3 text-xs text-[var(--muted-foreground)]">
          <Loader2 className="h-3.5 w-3.5 flowix-spin" />
          {t("document.version.loading")}
        </div>
      )}

      {!loading && failed && (
        <div className="px-2 py-3 text-xs text-[var(--muted-foreground)]">
          {t("document.version.loadFailed")}
        </div>
      )}

      {!loading && !failed && versions.length === 0 && (
        <div className="px-2 py-3 text-xs text-[var(--muted-foreground)]">
          {t("document.version.empty")}
        </div>
      )}

      {!loading && !failed && versions.map((version) => (
        <VersionListItem
          key={version.id}
          version={version}
          relativePath={relativePath}
          restoringVersionId={restoringVersionId}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export function VersionHistorySubmenu({
  notebookId,
  relativePath,
  refreshKey,
  restoringVersionId,
  onSelectVersion,
}: {
  notebookId: string;
  relativePath: string;
  refreshKey: number;
  restoringVersionId: string | null;
  onSelectVersion: (version: VersionDisplay) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { versions, loading, failed } = useVersionHistoryList(notebookId, relativePath, refreshKey, open);

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="group flex h-7 w-full cursor-pointer items-center justify-start gap-2 rounded-lg px-2 py-0 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
        onFocus={() => setOpen(true)}
      >
        <ClockIcon className="h-4 w-4" />
        <span className="flex-1 text-left">{t("document.version.menuLabel")}</span>
        <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]" />
      </button>

      {open && (
        <div className="absolute right-full top-0 z-[151] w-[300px] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <div
            className="flex items-center justify-between"
            style={{ padding: '0.15rem 0.375rem 0.35rem' }}
          >
            <div
              className="text-[var(--muted-foreground)]"
              style={{ fontSize: '0.75rem', lineHeight: 1.2 }}
            >
              {t("document.version.allHistory")}
            </div>
            <div className="text-[11px] text-[var(--muted-foreground)]">
              {versions.length}
            </div>
          </div>

          <div className="max-h-[272px] overflow-y-auto px-1">
            <VersionListBody
              loading={loading}
              failed={failed}
              versions={versions}
              relativePath={relativePath}
              restoringVersionId={restoringVersionId}
              onSelect={(version) => {
                setOpen(false);
                onSelectVersion(version);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 移动端历史版本选择弹窗。触屏没有 hover, 且向左弹的子菜单会被屏幕边缘裁剪
 * (见 docs/VERSION-HISTORY-CLOUD.md §4.3), 因此用贴底弹窗承载同一份列表;
 * 数据加载与行渲染与桌面子菜单完全共享。
 */
export function VersionHistoryDialog({
  open,
  onOpenChange,
  notebookId,
  relativePath,
  refreshKey,
  restoringVersionId,
  onSelectVersion,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notebookId: string;
  relativePath: string;
  refreshKey: number;
  restoringVersionId: string | null;
  onSelectVersion: (version: VersionDisplay) => void;
}) {
  const { t } = useI18n();
  const { versions, loading, failed } = useVersionHistoryList(notebookId, relativePath, refreshKey, open);
  useMobileBackInterceptor(open, () => {
    onOpenChange(false);
    return true;
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 贴底弹窗: 覆盖居中定位 (wrapper 为 flex 容器, self-end 底对齐), 顶边圆角。 */}
      <DialogContent className="flex max-h-[70dvh] w-full flex-col self-end rounded-b-none rounded-t-2xl px-4 pb-4 pt-3 max-w-none">
        <div className="flex items-center justify-between pr-10">
          <DialogTitle>{t("document.version.menuLabel")}</DialogTitle>
          <span className="text-[11px] text-[var(--muted-foreground)]">{versions.length}</span>
        </div>

        <div className="mt-1 flex-1 overflow-y-auto px-1 pt-1">
          <VersionListBody
            loading={loading}
            failed={failed}
            versions={versions}
            relativePath={relativePath}
            restoringVersionId={restoringVersionId}
            onSelect={(version) => {
              onOpenChange(false);
              onSelectVersion(version);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** `enabled` 期间加载云端版本列表; requestSeq 防止过期响应回写。 */
function useCloudHistoryList(
  notebookId: string,
  relativePath: string,
  refreshKey: number,
  enabled: boolean,
) {
  const { t } = useI18n();
  const [items, setItems] = useState<FnsCloudVersionMeta[]>([]);
  const [notSynced, setNotSynced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    setFailed(false);
    setNotSynced(false);

    void fnsClient.listNoteHistory(notebookId, relativePath)
      .then((page) => {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
        if (page.status === 'notSynced') {
          setNotSynced(true);
          setItems([]);
        } else {
          setItems(page.items);
        }
      })
      .catch((err) => {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
        logger.error('list cloud versions failed', { error: err, notebookId, relativePath });
        setFailed(true);
        toast.error(t('document.version.cloud.loadFailed'));
      })
      .finally(() => {
        if (mountedRef.current && requestSeqRef.current === requestSeq) {
          setLoading(false);
        }
      });
  }, [enabled, notebookId, relativePath, refreshKey, t]);

  const orderedItems = useMemo(
    () => [...items].sort((a, b) => b.createdAtMs - a.createdAtMs),
    [items],
  );

  return { items: orderedItems, loading, failed, notSynced };
}

function CloudVersionListItem({
  version,
  relativePath,
  restoringVersionId,
  onSelect,
}: {
  version: FnsCloudVersionMeta;
  relativePath: string;
  restoringVersionId: string | null;
  onSelect: (version: FnsCloudVersionMeta) => void;
}) {
  const { language } = useI18n();
  const isRestoring = restoringVersionId === `cloud-${version.historyId}`;
  return (
    <button
      type="button"
      disabled={isRestoring}
      onClick={() => onSelect(version)}
      className="group block w-full rounded-lg px-2 py-2 text-left hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-60"
      title={relativePath}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--foreground)] group-hover:text-[var(--foreground)]">
          {formatVersionTime(version.createdAtMs, language)}
        </span>
        {isRestoring && (
          <Loader2 className="h-3 w-3 flowix-spin text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]" />
        )}
        {/* 云端独有: 哪台设备产生的修改 */}
        <span className="shrink-0 rounded bg-[var(--background)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)] group-hover:bg-[var(--card)] group-hover:text-[var(--foreground)]">
          {version.clientName || version.clientType}
          {version.clientVersion ? ` · ${version.clientVersion}` : ''}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]">
        <span className="min-w-0 flex-1 truncate group-hover:text-[var(--foreground)]">
          {relativePath}
        </span>
        <span className="shrink-0">v{version.version}</span>
      </div>
    </button>
  );
}

function CloudListBody({
  loading,
  failed,
  notSynced,
  items,
  relativePath,
  restoringVersionId,
  onSelect,
}: {
  loading: boolean;
  failed: boolean;
  notSynced: boolean;
  items: FnsCloudVersionMeta[];
  relativePath: string;
  restoringVersionId: string | null;
  onSelect: (version: FnsCloudVersionMeta) => void;
}) {
  const { t } = useI18n();
  const emptyKey = notSynced
    ? 'document.version.cloud.notSynced'
    : 'document.version.cloud.empty';
  return (
    <>
      {loading && (
        <div className="flex items-center gap-1 px-2 py-3 text-xs text-[var(--muted-foreground)]">
          <Loader2 className="h-3.5 w-3.5 flowix-spin" />
          {t('document.version.loading')}
        </div>
      )}

      {!loading && failed && (
        <div className="px-2 py-3 text-xs text-[var(--muted-foreground)]">
          {t('document.version.cloud.loadFailed')}
        </div>
      )}

      {!loading && !failed && items.length === 0 && (
        <div className="px-2 py-3 text-xs text-[var(--muted-foreground)]">
          {t(emptyKey)}
        </div>
      )}

      {!loading && !failed && items.map((version) => (
        <CloudVersionListItem
          key={version.historyId}
          version={version}
          relativePath={relativePath}
          restoringVersionId={restoringVersionId}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

function useCloudHistoryBody(props: {
  notebookId: string;
  relativePath: string;
  refreshKey: number;
  enabled: boolean;
  restoringVersionId: string | null;
  onSelect: (version: FnsCloudVersionMeta) => void;
}) {
  const { items, loading, failed, notSynced } = useCloudHistoryList(
    props.notebookId, props.relativePath, props.refreshKey, props.enabled,
  );
  const body = (
    <CloudListBody
      loading={loading}
      failed={failed}
      notSynced={notSynced}
      items={items}
      relativePath={props.relativePath}
      restoringVersionId={props.restoringVersionId}
      onSelect={props.onSelect}
    />
  );
  return { body, count: items.length };
}

/** 桌面端: hover 二级子菜单, 结构与本地历史版本子菜单一致。 */
export function CloudHistorySubmenu({
  notebookId,
  relativePath,
  refreshKey,
  restoringVersionId,
  onSelectVersion,
}: {
  notebookId: string;
  relativePath: string;
  refreshKey: number;
  restoringVersionId: string | null;
  onSelectVersion: (version: FnsCloudVersionMeta) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { body, count } = useCloudHistoryBody({
    notebookId, relativePath, refreshKey, enabled: open, restoringVersionId,
    onSelect: (version) => {
      setOpen(false);
      onSelectVersion(version);
    },
  });

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="group flex h-7 w-full cursor-pointer items-center justify-start gap-2 rounded-lg px-2 py-0 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
        onFocus={() => setOpen(true)}
      >
        <CloudArrowUpIcon className="h-4 w-4" />
        <span className="flex-1 text-left">{t('document.version.cloud.menuLabel')}</span>
        <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]" />
      </button>

      {open && (
        <div className="absolute right-full top-0 z-[151] w-[300px] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
          <div
            className="flex items-center justify-between"
            style={{ padding: '0.15rem 0.375rem 0.35rem' }}
          >
            <div
              className="text-[var(--muted-foreground)]"
              style={{ fontSize: '0.75rem', lineHeight: 1.2 }}
            >
              {t('document.version.allHistory')}
            </div>
            <div className="text-[11px] text-[var(--muted-foreground)]">
              {count}
            </div>
          </div>

          <div className="max-h-[272px] overflow-y-auto px-1">
            {body}
          </div>
        </div>
      )}
    </div>
  );
}

/** 移动端: 贴底弹窗, 与本地历史弹窗同形态 (触屏无 hover 且子菜单会被屏幕裁剪)。 */
export function CloudHistoryDialog({
  open,
  onOpenChange,
  notebookId,
  relativePath,
  refreshKey,
  restoringVersionId,
  onSelectVersion,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notebookId: string;
  relativePath: string;
  refreshKey: number;
  restoringVersionId: string | null;
  onSelectVersion: (version: FnsCloudVersionMeta) => void;
}) {
  const { t } = useI18n();
  const { body, count } = useCloudHistoryBody({
    notebookId, relativePath, refreshKey, enabled: open, restoringVersionId,
    onSelect: (version) => {
      onOpenChange(false);
      onSelectVersion(version);
    },
  });
  useMobileBackInterceptor(open, () => {
    onOpenChange(false);
    return true;
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[70dvh] w-full flex-col self-end rounded-b-none rounded-t-2xl px-4 pb-4 pt-3 max-w-none">
        <div className="flex items-center justify-between pr-10">
          <DialogTitle>{t('document.version.cloud.menuLabel')}</DialogTitle>
          <span className="text-[11px] text-[var(--muted-foreground)]">{count}</span>
        </div>

        <div className="mt-1 flex-1 overflow-y-auto px-1 pt-1">
          {body}
        </div>
      </DialogContent>
    </Dialog>
  );
}
