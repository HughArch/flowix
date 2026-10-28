import { useState } from 'react';
import { Check, Code2, Ellipsis, Lock } from 'lucide-react';
import { LinkSimpleIcon, CopyIcon, FolderOpenIcon, FileMdIcon, FileDocIcon, FilePdfIcon, ClockIcon, MapPinSimpleAreaIcon, ShareNetworkIcon, TrashSimpleIcon, SwatchesIcon, ArrowsClockwiseIcon, LockSimpleIcon, LockSimpleOpenIcon } from '@phosphor-icons/react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@shared/ui/dropdown-menu';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@shared/ui/dialog';
import { FontSizeSwitcher } from '@shared/ui/font-size-switcher';
import { FolderCollectionSwitchConfirmDialog } from '@features/collection/public/folder-api';
import { useI18n, type I18nParams } from '@/lib/i18n';
import { isMobileDevice } from '@shared/platform';
import { fns } from '@platform/tauri/client';
import { useSyncPanelStore } from '@features/sync-status';
import { useMobileBackInterceptor } from '@features/shell/hooks/use-mobile-back-button';
import { EditorFontSwitcher } from './editor-font-switcher';
import { DocumentPageWidthSlider } from './document-page-width-slider';
import { NoteColorPicker } from './document-titlebar-controls';
import {
  CloudHistorySubmenu, CloudHistoryDialog,
  VersionHistorySubmenu, VersionHistoryDialog, formatVersionTime,
} from './document-version-history-menu';
import { DocumentShareDialog } from './document-share-dialog';
import { useDocumentTitlebarActions } from './use-document-titlebar-actions';
import type { DocumentTitlebarProps, DocumentTitlebarTarget } from './document-titlebar-model';
import type { DocumentEditorMode } from '@features/document/store/document-editor-view-store';

export function DocumentTitlebarActions({
  target,
  iconButtonClass,
  capabilities,
  actions,
  folderCollectionViewType,
  showEditorFontSwitcher = false,
  showEditorModeToggle = false,
  editorMode = 'rich',
  onSetEditorMode,
  visible = true,
}: {
  target: DocumentTitlebarTarget;
  iconButtonClass: string;
  capabilities: DocumentTitlebarProps['contentCapabilities'];
  actions: DocumentTitlebarProps['actions'];
  folderCollectionViewType?: DocumentTitlebarProps['folderCollectionViewType'];
  showEditorFontSwitcher?: boolean;
  showEditorModeToggle?: boolean;
  editorMode?: DocumentEditorMode;
  onSetEditorMode?: (mode: DocumentEditorMode) => void;
  visible?: boolean;
}) {
  const {
    copyFullText: canCopyFullText, memoColors: canEditColors, exportContent: canExportContent,
    saveAsTemplate: canSaveAsTemplate, versionHistory: canViewVersionHistory,
  } = capabilities;
  const {
    onCopyLink: onCopyPath, onCopyFullText, onExportMarkdown, onExportWord,
    onExportPdf, onSaveAsTemplate, onDeleteExternalFile,
  } = actions;
  const { t, language } = useI18n();
  const {
    colors, changeColors, fontSwitch, selectedFontSizeMode, setEditorFontSizeMode,
    lock,
    confirmVersion, setConfirmVersion, requestRestoreVersion,
    confirmCloudVersion, setConfirmCloudVersion, requestRestoreCloudVersion, restoreCloudVersion,
    restoringVersionId, versionRefreshKey,
    archiveVersion, restorePathVersion, copyFolderPath, revealFile,
  } = useDocumentTitlebarActions(target);
  const { locked, busy: lockBusy, toggle: toggleLock } = lock;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingViewType, setPendingViewType] = useState<'table' | 'media_library' | null>(null);
  // 移动端历史版本选择弹窗 (桌面走 hover 子菜单, 不经过此状态)。
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [cloudHistoryDialogOpen, setCloudHistoryDialogOpen] = useState(false);
  // 分享弹窗桌面/移动共用同一形态。
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  // notebook 是否绑定了 FNS (云端历史/分享入口门控; 菜单每次打开时重新查询, 关闭即失效)。
  const [cloudAvailable, setCloudAvailable] = useState(false);
  // 触屏上恢复确认弹窗也要接住 Android 返回键, 避免弹窗开着先退回列表。
  useMobileBackInterceptor(!!confirmVersion || !!confirmCloudVersion, () => {
    setConfirmVersion(null);
    setConfirmCloudVersion(null);
    return true;
  });
  const filePath = target.fileIdentity.path;
  const indexable = target.indexable;
  const hideDeleteAction = Boolean(folderCollectionViewType || target.isOutsideCurrentNotebook);
  const itemClass = 'group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]';
  const handleCopyPath = () => folderCollectionViewType || target.isOutsideCurrentNotebook
    ? copyFolderPath() : onCopyPath();

  if (!visible) return null;

  return (
    <>
    {canEditColors && !locked && (
      <NoteColorPicker colors={colors} iconButtonClass={iconButtonClass}
        onChange={changeColors} />
    )}
    {locked && (
      <span
        role="img"
        aria-label={t('document.lock.tooltip')}
        title={t('document.lock.tooltip')}
        className="flex h-8 w-8 shrink-0 items-center justify-center text-[var(--muted-foreground)]"
      >
        <Lock className="h-4 w-4" />
      </span>
    )}
    <DropdownMenu onOpenChange={(open) => {
      // 只在打开时刷新绑定状态; 关闭不能重置 —— 菜单收起后云端弹窗仍由
      // cloudAvailable 门控, 重置会连带卸载刚要打开的弹窗。
      if (open && target.notebookId) {
        fns.cloudHistoryAvailable(target.notebookId)
          .then(setCloudAvailable)
          .catch(() => setCloudAvailable(false));
      }
    }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={iconButtonClass}
          aria-label={t('document.titlebar.moreTooltip')}
          title={t('document.titlebar.moreTooltip')}
        >
          <Ellipsis className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[200px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        {folderCollectionViewType ? (
          <>
            <div className="flex shrink-0 items-center justify-between gap-2 px-2 py-1 text-xs font-normal uppercase tracking-wider text-[var(--muted-foreground)]">
              <span>内容偏好</span>
              <span className="inline-flex items-center gap-1 rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] normal-case tracking-normal">
                文件夹
              </span>
            </div>
            {([['table', '展示笔记'], ['media_library', '展示图/视频']] as const).map(([type, label]) => (
              <DropdownMenuItem key={type} onClick={() => { if (type !== folderCollectionViewType.current) setPendingViewType(type); }} className={itemClass}>
                <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
                  {folderCollectionViewType.current === type && <Check className="h-4 w-4 text-[var(--brand)]" />}
                </span>
                <span className="flex-1">{label}</span>
              </DropdownMenuItem>
            ))}
            <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
          </>
        ) : showEditorFontSwitcher ? <>
          <EditorFontSwitcher
            fontMode={fontSwitch.fontMode}
            downloadingMode={fontSwitch.downloadingMode}
            onSelect={fontSwitch.selectFontMode}
          />
          <FontSizeSwitcher sizeMode={selectedFontSizeMode} onSelect={setEditorFontSizeMode} />
          <DocumentPageWidthSlider />
        </> : null}
        <DropdownMenuItem onClick={() => void handleCopyPath()} className={itemClass}>
          <LinkSimpleIcon className="h-4 w-4" /> {t('memo.fileTree.copyPath')}
        </DropdownMenuItem>
        {canCopyFullText && (
          <DropdownMenuItem onClick={onCopyFullText} className={itemClass}>
            <CopyIcon className="h-4 w-4" /> {t('document.action.copyFullText')}
          </DropdownMenuItem>
        )}
        {/* 移动端是 App 私有目录, 没有“在文件夹中显示”的对应物。 */}
        {!isMobileDevice() && (
          <DropdownMenuItem
            onClick={() => { void revealFile(); }}
            className={itemClass}
          >
            <FolderOpenIcon className="h-4 w-4" /> {t('document.file.reveal')}
          </DropdownMenuItem>
        )}
        {showEditorModeToggle && (
          <DropdownMenuItem
            onClick={() => onSetEditorMode?.(editorMode === 'source' ? 'rich' : 'source')}
            className={itemClass}
          >
            <Code2 className="h-4 w-4" />
            {t(editorMode === 'source' ? 'document.action.richTextMode' : 'document.action.sourceMode')}
          </DropdownMenuItem>
        )}
        {(canSaveAsTemplate || canExportContent) && (
          <>
            <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
            {canSaveAsTemplate && (
              <DropdownMenuItem onClick={onSaveAsTemplate} className={itemClass}>
                <SwatchesIcon className="h-4 w-4" /> {t('document.action.saveAsTemplate')}
              </DropdownMenuItem>
            )}
            {canExportContent && (
              <>
                <DropdownMenuItem onClick={onExportMarkdown} className={itemClass}>
                  <FileMdIcon className="h-4 w-4" /> {t('document.action.exportMarkdown')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onExportWord} className={itemClass}>
                  <FileDocIcon className="h-4 w-4" /> {t('document.action.exportWord')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onExportPdf} className={itemClass}>
                  <FilePdfIcon className="h-4 w-4" /> {t('document.action.exportPdf')}
                </DropdownMenuItem>
              </>
            )}
          </>
        )}
        {canViewVersionHistory && target.notebookId && target.relativePath && (
          <>
            <DropdownMenuItem className={itemClass} onClick={() => { void archiveVersion(); }}><ClockIcon className="h-4 w-4" /> 保存归档</DropdownMenuItem>
            {isMobileDevice() ? (
              <DropdownMenuItem className={itemClass} onClick={() => setHistoryDialogOpen(true)}>
                <ClockIcon className="h-4 w-4" /> {t('document.version.menuLabel')}
              </DropdownMenuItem>
            ) : (
              <VersionHistorySubmenu
                notebookId={target.notebookId}
                relativePath={target.relativePath}
                refreshKey={versionRefreshKey}
                restoringVersionId={restoringVersionId}
                onSelectVersion={requestRestoreVersion}
              />
            )}
            {cloudAvailable && (
              isMobileDevice() ? (
                <DropdownMenuItem className={itemClass} onClick={() => setCloudHistoryDialogOpen(true)}>
                  <ClockIcon className="h-4 w-4" /> {t('document.version.cloud.menuLabel')}
                </DropdownMenuItem>
              ) : (
                <CloudHistorySubmenu
                  notebookId={target.notebookId}
                  relativePath={target.relativePath}
                  refreshKey={versionRefreshKey}
                  restoringVersionId={restoringVersionId}
                  onSelectVersion={requestRestoreCloudVersion}
                />
              )
            )}
          </>
        )}
        {cloudAvailable && target.notebookId && target.relativePath && !folderCollectionViewType && (
          <DropdownMenuItem className={itemClass} onClick={() => setShareDialogOpen(true)}>
            <ShareNetworkIcon className="h-4 w-4" /> {t('share.menuLabel')}
          </DropdownMenuItem>
        )}
        <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
        {(indexable || locked) && (
          <DropdownMenuItem
            className={itemClass}
            disabled={lockBusy}
            onClick={() => { void toggleLock(); }}
          >
            {locked
              ? <LockSimpleOpenIcon className="h-4 w-4" />
              : <LockSimpleIcon className="h-4 w-4" />}
            {t(locked ? 'document.action.unlock' : 'document.action.lock')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          className={itemClass}
          onClick={() => useSyncPanelStore.getState().setOpen(true)}
        >
          <ArrowsClockwiseIcon className="h-4 w-4" /> {t('sync.panel.open')}
        </DropdownMenuItem>
        {!hideDeleteAction && <DropdownMenuItem
          onClick={() => setConfirmDelete(true)}
          className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-transparent hover:text-[var(--destructive)]"
        >
          <TrashSimpleIcon className="h-4 w-4" /> {t(indexable ? 'memo.delete.confirm' : 'document.external.deleteFile')}
        </DropdownMenuItem>}
        {folderCollectionViewType && (
          <>
            <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
            <DropdownMenuItem onClick={folderCollectionViewType.onToggleDefaultFolder} className={itemClass}>
              <MapPinSimpleAreaIcon className="h-4 w-4" aria-hidden="true" />
              {t(folderCollectionViewType.isDefaultFolder ? 'memo.fileTree.clearDefaultCreateFolder' : 'memo.fileTree.setDefaultCreateFolder')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
      <FolderCollectionSwitchConfirmDialog
        open={pendingViewType !== null}
        onOpenChange={(open) => { if (!open) setPendingViewType(null); }}
        onConfirm={() => {
          const type = pendingViewType;
          setPendingViewType(null);
          if (type) folderCollectionViewType?.onSelect(type);
        }}
      />
      {!hideDeleteAction && <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(indexable ? 'memo.delete.title' : 'document.external.deleteFileTitle')}</DialogTitle>
            <DialogDescription>
              {t(indexable ? 'memo.delete.description' : 'document.external.deleteFileDescription', { name: filePath.split(/[\\/]/).pop() ?? filePath })}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmDelete(false)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]">
              {t('dialog.cancel')}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmDelete(false);
                void onDeleteExternalFile();
              }}
              className="h-8 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)] hover:border-[var(--destructive)] hover:bg-transparent hover:text-[var(--destructive)]"
            >
              {t(indexable ? 'memo.delete.confirm' : 'document.external.deleteFileConfirm')}
            </button>
          </div>
        </DialogContent>
      </Dialog>}
      <Dialog open={!!confirmVersion} onOpenChange={(open) => !open && setConfirmVersion(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('document.version.confirmTitle')}</DialogTitle>
            <DialogDescription>{t('document.version.confirmDescription', {
              time: confirmVersion ? formatVersionTime(confirmVersion.createdAt, language) : '',
            } satisfies I18nParams)}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" disabled={!!restoringVersionId} onClick={() => setConfirmVersion(null)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)] disabled:opacity-60">
              {t('document.version.cancel')}
            </button>
            <button type="button" disabled={!!restoringVersionId} onClick={() => { void restorePathVersion(); }} className="h-8 rounded-lg bg-[var(--primary)] px-3 text-sm text-[var(--primary-foreground)] disabled:opacity-60">
              {t('document.version.confirm')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
      {canViewVersionHistory && target.notebookId && target.relativePath && (
        <>
          <VersionHistoryDialog
            open={historyDialogOpen}
            onOpenChange={setHistoryDialogOpen}
            notebookId={target.notebookId}
            relativePath={target.relativePath}
            refreshKey={versionRefreshKey}
            restoringVersionId={restoringVersionId}
            onSelectVersion={requestRestoreVersion}
          />
          {cloudAvailable && (
            <CloudHistoryDialog
              open={cloudHistoryDialogOpen}
              onOpenChange={setCloudHistoryDialogOpen}
              notebookId={target.notebookId}
              relativePath={target.relativePath}
              refreshKey={versionRefreshKey}
              restoringVersionId={restoringVersionId}
              onSelectVersion={requestRestoreCloudVersion}
            />
          )}
          <Dialog open={!!confirmCloudVersion} onOpenChange={(open) => !open && setConfirmCloudVersion(null)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('document.version.confirmTitle')}</DialogTitle>
                <DialogDescription>{t('document.version.cloud.confirmDescription', {
                  time: confirmCloudVersion ? formatVersionTime(confirmCloudVersion.createdAtMs, language) : '',
                } satisfies I18nParams)}</DialogDescription>
              </DialogHeader>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" disabled={!!restoringVersionId} onClick={() => setConfirmCloudVersion(null)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)] disabled:opacity-60">
                  {t('document.version.cancel')}
                </button>
                <button type="button" disabled={!!restoringVersionId} onClick={() => { void restoreCloudVersion(); }} className="h-8 rounded-lg bg-[var(--primary)] px-3 text-sm text-[var(--primary-foreground)] disabled:opacity-60">
                  {t('document.version.confirm')}
                </button>
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
      {cloudAvailable && target.notebookId && target.relativePath && (
        <DocumentShareDialog
          open={shareDialogOpen}
          onOpenChange={setShareDialogOpen}
          notebookId={target.notebookId}
          relativePath={target.relativePath}
        />
      )}
    </DropdownMenu>
    </>
  );
}
