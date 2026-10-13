'use client';

import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type NoteSettingsTab = 'templates' | 'properties' | 'documentManagement';

class SectionErrorBoundary extends Component<{
  children: ReactNode;
  errorText: string;
  retryText: string;
}, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[NoteSettingsSection] section failed to render:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center" role="alert">
          <p className="text-sm text-[var(--muted-foreground)]">{this.props.errorText}</p>
          <button
            type="button"
            className="text-sm text-[var(--primary)] hover:underline"
            onClick={() => this.setState({ hasError: false })}
          >
            {this.props.retryText}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const TemplatesSection = lazy(() =>
  import('@features/preferences/sections/templates').then((module) => ({ default: module.TemplatesSection })),
);
const DocumentPropertiesSection = lazy(() =>
  import('@features/preferences/sections/document-properties').then((module) => ({
    default: module.DocumentPropertiesSection,
  })),
);
const FileDisplayRulesSection = lazy(() =>
  import('@features/preferences/sections/file-display-rules').then((module) => ({
    default: module.FileDisplayRulesSection,
  })),
);

export function NoteSettingsSection() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<NoteSettingsTab>('templates');
  const tabs: { id: NoteSettingsTab; label: string }[] = [
    { id: 'templates', label: t('preferences.templates.title') },
    { id: 'properties', label: t('preferences.documentProperties.title') },
    { id: 'documentManagement', label: t('preferences.fileManagement.locationAndIndexTitle') },
  ];

  return (
    <div className="space-y-6">
      <div
        className="flex gap-6 border-b border-[var(--divider)]"
        role="tablist"
        aria-label={t('preferences.tabs.noteSettings')}
      >
        {tabs.map(({ id, label }) => {
          const selected = activeTab === id;
          return (
            <button
              key={id}
              id={`note-settings-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`note-settings-panel-${id}`}
              className={cn(
                'relative -mb-px min-w-0 border-b-2 px-0.5 py-2.5 text-base font-medium transition-colors',
                selected
                  ? 'border-[var(--primary)] text-[var(--primary)]'
                  : 'border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
              )}
              onClick={() => setActiveTab(id)}
            >
              <span className="block truncate">{label}</span>
            </button>
          );
        })}
      </div>

      <div
        id={`note-settings-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`note-settings-tab-${activeTab}`}
      >
        <SectionErrorBoundary
          key={activeTab}
          errorText={t('preferences.noteSettings.loadFailed')}
          retryText={t('preferences.noteSettings.retry')}
        >
          <Suspense
            fallback={(
              <div className="space-y-6" aria-busy="true">
                <div className="flex h-48 items-center justify-center" role="status" aria-label={t('preferences.general.loading')}>
                  <Loader2 className="size-6 animate-spin text-[var(--muted-foreground)]" />
                  <span className="sr-only">{t('preferences.general.loading')}</span>
                </div>
              </div>
            )}
          >
            {activeTab === 'templates' && <TemplatesSection hideSectionHeader />}
            {activeTab === 'properties' && <DocumentPropertiesSection hideSectionHeader />}
            {activeTab === 'documentManagement' && <FileDisplayRulesSection hideSectionHeader />}
          </Suspense>
        </SectionErrorBoundary>
      </div>
    </div>
  );
}
