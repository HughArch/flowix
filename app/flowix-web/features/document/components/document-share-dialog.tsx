import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { CopyIcon, EyeIcon, EyeSlashIcon, LinkIcon, PasswordIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { fns, FNS_SHARE_EXPIRY_OPTIONS, type FnsShareView } from '@platform/tauri/client';
import { useI18n, type AppLanguage } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@shared/ui/dialog';
import { Input } from '@shared/ui/input';
import { isMobileDevice } from '@shared/platform';
import { useMobileBackInterceptor } from '@features/shell/hooks/use-mobile-back-button';

const logger = createLogger('document-share');

/** 复制到剪贴板; WebView 未暴露 clipboard API 时返回 false 由调用方降级提示。 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 过期档位 → 传给服务端的绝对 unix 秒; 0 = 永久。 */
function expiryToUnixSeconds(deltaSeconds: number): number {
  if (deltaSeconds <= 0) return 0;
  return Math.floor(Date.now() / 1000) + deltaSeconds;
}

/** Go time.Time 零值 (RFC3339) = 永久有效。 */
export function shareNeverExpires(view: FnsShareView): boolean {
  return !view.expiresAt || view.expiresAt.startsWith('0001-01-01');
}

function formatExpiry(value: string, language: AppLanguage): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Intl.DateTimeFormat(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(parsed));
}

/**
 * 分享弹窗: 打开即查询当前分享状态, 无分享给创建表单, 有分享展示链接与
 * 管理 (改密码/有效期、取消分享) 操作。桌面为居中弹窗 (对齐全局搜索面板的
 * 视觉规范), 移动端保持贴底弹窗 (触屏可达性)。契约见 docs/NOTE-SHARE-CLOUD.md。
 */
export function DocumentShareDialog({
  open,
  onOpenChange,
  notebookId,
  relativePath,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notebookId: string;
  relativePath: string;
}) {
  const { t, language } = useI18n();
  const [view, setView] = useState<FnsShareView | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [expiryDelta, setExpiryDelta] = useState(0);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback((enabled: boolean) => {
    if (!enabled) return;
    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    setFailed(false);
    setConfirmingCancel(false);
    void fns.shareQuery(notebookId, relativePath)
      .then((next) => {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
        setView(next);
      })
      .catch((err) => {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
        logger.error('share query failed', { error: err, notebookId, relativePath });
        setFailed(true);
        toast.error(t('share.queryFailed'));
      })
      .finally(() => {
        if (mountedRef.current && requestSeqRef.current === requestSeq) setLoading(false);
      });
  }, [notebookId, relativePath, t]);

  useEffect(() => {
    if (open) {
      setPassword('');
      setShowPassword(false);
      setExpiryDelta(0);
      refresh(true);
    }
  }, [open, refresh]);

  useMobileBackInterceptor(open, () => {
    onOpenChange(false);
    return true;
  });

  const withBusy = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleCreate = () => withBusy(async () => {
    try {
      const created = await fns.shareCreate(
        notebookId,
        relativePath,
        password.trim() || undefined,
        expiryToUnixSeconds(expiryDelta),
      );
      // 创建即复制: 分享的自然下一步就是粘贴到聊天/文档, 省掉一次手动点击。
      // 剪贴板不可用时退化为普通创建提示, 链接仍在弹窗里可手动复制。
      const copied = await copyToClipboard(created.shareUrl);
      toast.success(t(copied ? 'share.createdAndCopied' : 'share.created'));
      refresh(true);
    } catch (err) {
      logger.error('share create failed', { error: err, notebookId, relativePath });
      toast.error(t('share.actionFailed'));
    }
  });

  const handleUpdate = () => withBusy(async () => {
    try {
      // 服务端语义: 空密码 = 移除密码; expireAt 0 = 永久。表单即完整目标状态。
      await fns.sharePassword(
        notebookId,
        relativePath,
        password.trim() || undefined,
        expiryToUnixSeconds(expiryDelta),
      );
      toast.success(t('share.updated'));
      refresh(true);
    } catch (err) {
      logger.error('share update failed', { error: err, notebookId, relativePath });
      toast.error(t('share.actionFailed'));
    }
  });

  const handleCancelShare = () => withBusy(async () => {
    try {
      await fns.shareCancel(notebookId, relativePath);
      toast.success(t('share.cancelled'));
      refresh(true);
    } catch (err) {
      logger.error('share cancel failed', { error: err, notebookId, relativePath });
      toast.error(t('share.actionFailed'));
    }
  });

  const handleCopy = () => {
    if (!view) return;
    void copyToClipboard(view.shareUrl)
      .then((copied) => {
        if (copied) toast.success(t('share.linkCopied'));
        else toast.error(t('share.copyFailed'));
      });
  };

  const expiryChips = (
    <div className="flex flex-wrap gap-1.5">
      {FNS_SHARE_EXPIRY_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={busy}
          onClick={() => setExpiryDelta(option.value)}
          className={`h-7 rounded-lg border px-2.5 text-xs transition-colors disabled:opacity-50 ${
            expiryDelta === option.value
              ? 'border-[var(--brand)] bg-[var(--brand)]/10 text-[var(--brand)]'
              : 'border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
          }`}
        >
          {t(option.i18nKey)}
        </button>
      ))}
    </div>
  );

  const passwordInput = (
    <div className="relative">
      <Input
        type={showPassword ? 'text' : 'password'}
        value={password}
        disabled={busy}
        onChange={(event) => setPassword(event.target.value)}
        placeholder={t(view ? 'share.password.placeholder.update' : 'share.password.placeholder.create')}
        className="h-9 pr-9 text-sm"
      />
      <button
        type="button"
        aria-label={t(showPassword ? 'share.password.hide' : 'share.password.show')}
        onClick={() => setShowPassword((value) => !value)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      >
        {showPassword ? <EyeSlashIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
      </button>
    </div>
  );

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="flex flex-1 items-center justify-center gap-2 py-10 text-sm text-[var(--muted-foreground)]">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('share.loading')}
      </div>
    );
  } else if (failed) {
    body = (
      <div className="flex flex-1 items-center justify-center py-10 text-sm text-[var(--muted-foreground)]">
        {t('share.queryFailed')}
      </div>
    );
  } else if (!view) {
    body = (
      <div className="flex flex-col gap-3 pt-1">
        <p className="text-xs text-[var(--muted-foreground)]">{t('share.createHint')}</p>
        {passwordInput}
        {expiryChips}
        <Button type="button" disabled={busy} onClick={() => { void handleCreate(); }} className="h-9 text-sm">
          <LinkIcon className="h-4 w-4" /> {t('share.createAction')}
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3 pt-1">
        <div className="flex items-center gap-1.5">
          <Input
            type="text"
            readOnly
            value={view.shareUrl}
            onFocus={(event) => event.currentTarget.select()}
            className="h-9 flex-1 text-sm"
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={handleCopy}
            className="h-9 shrink-0 px-3 text-sm"
            aria-label={t('share.copyLink')}
          >
            <CopyIcon className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--muted-foreground)]">
          <span className="inline-flex items-center gap-1">
            <PasswordIcon className="h-3.5 w-3.5" />
            {view.isPassword ? t('share.password.on') : t('share.password.off')}
          </span>
          <span>
            {shareNeverExpires(view)
              ? t('share.expiry.neverActive')
              : t('share.expiry.activeUntil', { time: formatExpiry(view.expiresAt, language) })}
          </span>
        </div>
        <div className="h-px bg-[var(--border)]" role="separator" aria-hidden="true" />
        <p className="text-xs font-medium text-[var(--foreground)]">{t('share.updateSection')}</p>
        {passwordInput}
        {expiryChips}
        <Button type="button" variant="outline" disabled={busy} onClick={() => { void handleUpdate(); }} className="h-9 text-sm">
          {t('share.updateAction')}
        </Button>
        <div className="h-px bg-[var(--border)]" role="separator" aria-hidden="true" />
        {confirmingCancel ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-[var(--destructive)]">{t('share.cancelConfirmHint')}</p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => { void handleCancelShare(); }}
                className="h-9 flex-1 text-sm"
              >
                {t('share.cancelConfirm')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setConfirmingCancel(false)}
                className="h-9 flex-1 text-sm"
              >
                {t('share.cancelDismiss')}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirmingCancel(true)}
            className="h-9 justify-start text-sm text-[var(--destructive)] hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]"
          >
            <TrashSimpleIcon className="h-4 w-4" /> {t('share.cancelAction')}
          </Button>
        )}
      </div>
    );
  }

  // 桌面居中 (与全局搜索面板同一套 popover 视觉: popover 底色 / border-popup /
  // 24px 投影), 移动端保留贴底弹窗形态。
  const contentClassName = isMobileDevice()
    ? 'flex max-h-[70dvh] w-full flex-col self-end overflow-y-auto rounded-b-none rounded-t-2xl px-4 pb-4 pt-3 max-w-none'
    : 'flex w-[440px] max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-xl border border-[var(--border-popup)] bg-[var(--popover)] px-5 pb-5 pt-4 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={contentClassName}>
        <div className="flex items-center justify-between pr-10">
          <DialogTitle>{t('share.menuLabel')}</DialogTitle>
        </div>
        {body}
      </DialogContent>
    </Dialog>
  );
}
