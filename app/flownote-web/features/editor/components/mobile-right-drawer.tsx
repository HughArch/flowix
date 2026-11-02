import type { Editor } from '@tiptap/core'
import { ListBulletsIcon } from '@phosphor-icons/react'
import { createPortal } from 'react-dom'
import { useEffect } from 'react'
import { useI18n } from '@/lib/i18n'
import { HeadingOutlinePanel } from '@features/editor/components/heading-outline-navigation'
import { useMobileRightDrawerStore } from '@features/editor/components/mobile-right-drawer-store'

/**
 * 移动端右侧抽屉 (参考 Obsidian 的右栏):
 *   - 标题栏一排 tab 图标按钮, 目前只有「目录」, 默认选中;
 *   - 面板体渲染当前 tab 的内容;
 *   - 点遮罩 / Esc 关闭; 左滑手势的 `flownote:open-outline` 事件在这里接住
 *     (旧右缘命中条已从移动端移除, 该事件原先由它消费)。
 */
export function MobileRightDrawer({ editor }: { editor: Editor }) {
  const { t } = useI18n()
  const isOpen = useMobileRightDrawerStore((state) => state.isOpen)
  const tab = useMobileRightDrawerStore((state) => state.tab)
  const close = useMobileRightDrawerStore((state) => state.close)

  // 左滑手势沿用既有事件名; 抽屉是移动端目录的唯一入口。
  useEffect(() => {
    const openOutline = () => useMobileRightDrawerStore.setState({ isOpen: true, tab: 'outline' })
    window.addEventListener('flownote:open-outline', openOutline)
    return () => window.removeEventListener('flownote:open-outline', openOutline)
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [isOpen, close])

  if (!isOpen || typeof document === 'undefined') return null

  return createPortal(
    <>
      <div className="mobile-right-drawer-backdrop" onClick={close} />
      <aside className="mobile-right-drawer" role="dialog" data-mobile-swipe-ignore="" aria-label={t('editor.headingOutline.title')}>
        <div className="mobile-right-drawer__tabs">
          <button
            type="button"
            className={`mobile-right-drawer__tab${tab === 'outline' ? ' active' : ''}`}
            aria-label={t('editor.headingOutline.title')}
            aria-pressed={tab === 'outline'}
            onClick={() => useMobileRightDrawerStore.setState({ tab: 'outline' })}
          >
            <ListBulletsIcon size={16} weight="bold" />
          </button>
          {/* 面板标题跟在激活 tab 后, 避免整行只有一个孤零零的小图标 */}
          <span className="mobile-right-drawer__tab-label">
            {tab === 'outline' ? t('editor.headingOutline.title') : ''}
          </span>
        </div>
        <div className="mobile-right-drawer__body">
          {tab === 'outline' && <HeadingOutlinePanel editor={editor} />}
        </div>
      </aside>
    </>,
    document.body,
  )
}
