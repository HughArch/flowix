'use client';

import { Suspense, useState, useEffect, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import {
	DEVELOPMENT_PREFERENCE_TAB_GROUP,
	PREFERENCE_TAB_BY_ID,
	PREFERENCE_TAB_GROUPS,
	type ActiveSettingsTab,
	type PreferencesTabGroup,
} from '@features/preferences/preferences-tab-config';
import { cn } from '@/lib/utils';
import { Button } from '@shared/ui/button';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { ErrorBoundary } from '@shared/error-boundary';
import { WindowsTitlebarControls } from '@shared/window-titlebar-controls';
import { PreferencesTitlebarMac } from '@features/preferences/preferences-titlebar-mac';
import { PreferencesTitlebarWin } from '@features/preferences/preferences-titlebar-win';
import { useI18n } from '@/lib/i18n';
import { getCurrentWindow } from '@platform/tauri/window';
import { useExperimentalMode } from '@platform/tauri/use-experimental-mode';
import { product, type ProductInfo } from '@platform/tauri/client';

function isWindowsPlatform(): boolean {
	return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}

const LEGACY_TAB_REDIRECTS: Readonly<Record<string, ActiveSettingsTab>> = {
	templates: 'noteSettings',
	documentProperties: 'noteSettings',
	fileDisplayRules: 'noteSettings',
	theme: 'general',
	cli: 'mcp',
	agent: 'aiAgent',
	modelConfig: 'aiAgent',
	agents: 'aiAgent',
	cloudSync: 'fnsSync',
};

function normalizeInitialTab(tab: string): ActiveSettingsTab | null {
	const redirected = LEGACY_TAB_REDIRECTS[tab];
	if (redirected) return redirected;
	return PREFERENCE_TAB_BY_ID.has(tab as ActiveSettingsTab) ? tab as ActiveSettingsTab : null;
}

function getVisibleTabGroups({ isDevBuild, experimental }: { isDevBuild: boolean; experimental: boolean }) {
	const groups: readonly PreferencesTabGroup<ActiveSettingsTab>[] = isDevBuild
		? [...PREFERENCE_TAB_GROUPS, DEVELOPMENT_PREFERENCE_TAB_GROUP]
		: PREFERENCE_TAB_GROUPS;
	return groups
		.map((group) => ({
			...group,
			tabs: group.tabs.filter((tab) => experimental || !tab.experimentalOnly),
		}))
		.filter((group) => group.tabs.length > 0);
}

interface PreferencesViewProps {
	initialTab?: string;
}

export function PreferencesView({ initialTab }: PreferencesViewProps) {
	const { t } = useI18n();
	const experimental = useExperimentalMode();
	const [activeTab, setActiveTab] = useState<ActiveSettingsTab>('general');
	const [tabRetryVersion, setTabRetryVersion] = useState(0);
	const [productInfo, setProductInfo] = useState<ProductInfo | null>(null);
	const title = t('preferences.title');
	const initialTabName = initialTab?.split('?')[0];

	useEffect(() => {
		product.getInfo().then(setProductInfo).catch(() => setProductInfo(null));
	}, []);

	const visibleTabGroups = useMemo(
		() => getVisibleTabGroups({ isDevBuild: productInfo?.isDevBuild ?? false, experimental }),
		[experimental, productInfo?.isDevBuild],
	);
	const visibleTabIds = useMemo(
		() => new Set(visibleTabGroups.flatMap((group) => group.tabs.map((tab) => tab.id))),
		[visibleTabGroups],
	);
	const activeTabDefinition = PREFERENCE_TAB_BY_ID.get(activeTab);
	const ActiveTabComponent = useMemo(
		() => activeTabDefinition?.createComponent() ?? null,
		[activeTabDefinition, tabRetryVersion],
	);

	useEffect(() => {
		if (initialTab) {
			const normalizedTab = normalizeInitialTab(initialTabName ?? initialTab);
				if (normalizedTab && visibleTabIds.has(normalizedTab)) {
				setActiveTab(normalizedTab);
			}
		}
	}, [experimental, initialTab, initialTabName, visibleTabIds]);

	useEffect(() => {
		if (!visibleTabIds.has(activeTab)) {
			setActiveTab('general');
		}
	}, [activeTab, visibleTabIds]);

	useEffect(() => {
		document.title = title;
		void getCurrentWindow().setTitle(title).catch(() => {
			// Browser preview or unavailable Tauri window API.
		});
	}, [title]);

	return (
		<div className="flex h-screen w-screen select-none flex-col overflow-hidden bg-[var(--background)]">
			<WindowsTitlebarControls showBottomBorder />
			{isWindowsPlatform() ? <PreferencesTitlebarWin /> : <PreferencesTitlebarMac />}
			<div className="flex-1 flex min-h-0">
				{/* Left sidebar */}
				<OverlayScrollbar
					className="flex h-full w-[204px] min-h-0 shrink-0 border-r border-solid border-[var(--divider)] bg-[var(--card)]"
					scrollerClassName="h-full min-h-0 px-2 pt-5 pb-2"
				>
					<nav aria-label={title} className="flex min-h-full flex-col gap-4">
						{visibleTabGroups.map((group) => (
							<div key={group.labelKey} className="space-y-1">
								<div className="px-2 pb-1 text-xs font-medium text-[var(--muted-foreground)]">
									{t(group.labelKey)}
								</div>
								<div className="space-y-0.5">
									{group.tabs.map((tab) => (
										<Button
											key={tab.id}
											// 始终走 ghost 变体, 选中态手动叠加 bg-muted 跟 ghost 的 hover
											// 同色, 在 light/dark 主题下都保持视觉一致。
											variant="ghost"
											size="sm"
											aria-current={activeTab === tab.id ? 'page' : undefined}
											className={cn(
												'w-full justify-start gap-1.5 py-4 rounded-lg',
												activeTab === tab.id &&
													'bg-muted hover:bg-muted dark:bg-[color-mix(in_oklch,var(--muted)_50%,transparent)] dark:hover:bg-[color-mix(in_oklch,var(--muted)_50%,transparent)]'
											)}
												onClick={() => setActiveTab(tab.id)}
										>
											{tab.icon}
											<span className="text-sm font-normal">{t(tab.labelKey)}</span>
										</Button>
									))}
								</div>
							</div>
						))}
					</nav>
				</OverlayScrollbar>
				{/* Right content */}
				<main aria-label={title} className="h-full min-w-0 min-h-0 flex-1">
					<OverlayScrollbar className="h-full w-full min-h-0" scrollerClassName="flex h-full min-h-0 flex-col">
						<div className="flex min-h-full flex-1 flex-col">
							<div className="flex flex-1 justify-center p-6 pb-0">
								<div className={cn('flex w-full flex-1 flex-col', activeTabDefinition?.contentWidth === 'wide' ? 'max-w-[760px]' : 'max-w-[500px]')}>
									{activeTabDefinition && (
										<ErrorBoundary
											key={`${activeTab}:${tabRetryVersion}`}
											fallback={(
												<div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-[color-mix(in_oklch,var(--destructive)_10%,transparent)] p-3" role="alert">
													<p className="text-sm text-[var(--destructive)]">{t('preferences.sectionLoadFailed')}</p>
									<Button type="button" size="sm" variant="outline" className="rounded-lg" onClick={() => setTabRetryVersion((version) => version + 1)}>
														{t('error.retry')}
													</Button>
												</div>
											)}
										>
											<Suspense fallback={(
												<div className="flex flex-1 items-center justify-center" role="status" aria-label={t('preferences.general.loading')}>
													<Loader2 className="size-6 flowix-spin text-[var(--muted-foreground)]" />
													<span className="sr-only">{t('preferences.general.loading')}</span>
												</div>
											)}>
												{ActiveTabComponent && <ActiveTabComponent
													productInfo={productInfo}
												/>}
											</Suspense>
										</ErrorBoundary>
									)}
									</div>
							</div>
							{/* 独立尾部块确保 WebKit 将留白计入 scrollHeight。 */}
							<div aria-hidden="true" className="h-10 shrink-0" />
						</div>
					</OverlayScrollbar>
				</main>
			</div>
		</div>
	);
}
