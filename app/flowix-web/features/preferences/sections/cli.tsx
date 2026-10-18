'use client';

import { useEffect } from 'react';
import { Check, Download, Loader2 } from 'lucide-react';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useCliLinkStatusStore } from '@features/preferences/store';
import { Button } from '@shared/ui/button';

interface CliCommandItem {
  command: string;
  usage: string;
  descriptionKey: I18nKey;
}

const CLI_COMMANDS: CliCommandItem[] = [
  {
    command: 'notebooks',
    usage: 'flowix notebooks',
    descriptionKey: 'preferences.cli.commands.notebooks',
  },
  {
    command: 'list',
    usage: 'flowix list <notebook>',
    descriptionKey: 'preferences.cli.commands.list',
  },
  {
    command: 'show',
    usage: 'flowix show <id>',
    descriptionKey: 'preferences.cli.commands.show',
  },
  {
    command: 'create',
    usage: 'echo "# title" | flowix create <notebook>',
    descriptionKey: 'preferences.cli.commands.create',
  },
  {
    command: 'delete',
    usage: 'flowix delete <id>',
    descriptionKey: 'preferences.cli.commands.delete',
  },
  {
    command: 'edit',
    usage: 'flowix edit <id> --old <text> --new <text>',
    descriptionKey: 'preferences.cli.commands.edit',
  },
  {
    command: 'write',
    usage: 'printf "# title\\nbody\\n" | flowix write <id>',
    descriptionKey: 'preferences.cli.commands.write',
  },
  {
    command: 'search',
    usage: 'flowix search <query> --limit 20',
    descriptionKey: 'preferences.cli.commands.search',
  },
  {
    command: 'completion',
    usage: 'flowix completion <bash|zsh|fish>',
    descriptionKey: 'preferences.cli.commands.completion',
  },
  {
    command: 'plugin create',
    usage: 'printf "# Root\\n\\n## Branch\\n- Leaf\\n" | flowix plugin create mindmap -b <notebook> --json',
    descriptionKey: 'preferences.cli.commands.pluginCreate',
  },
];

export function CliSection() {
  const { t } = useI18n();
  const status = useCliLinkStatusStore((s) => s.status);
  const loading = useCliLinkStatusStore((s) => s.isChecking);
  const installing = useCliLinkStatusStore((s) => s.isInstalling);
  const error = useCliLinkStatusStore((s) => s.error);
  const refreshIfStale = useCliLinkStatusStore((s) => s.refreshIfStale);
  const installPath = useCliLinkStatusStore((s) => s.installPath);

  useEffect(() => {
    void refreshIfStale();
  }, [refreshIfStale]);

  const statusText = loading
    ? t('preferences.cli.status.checking')
    : !status
      ? t('preferences.cli.status.unknown')
      : status.needsInstall
      ? t('preferences.cli.status.needsInstall')
      : t('preferences.cli.status.available');

  return (
    <div className="space-y-4 pb-6">
      <SectionHeader title={t('preferences.cli.title')} />
      <div className="space-y-2">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
          <div className="flex min-h-9 items-center gap-2.5">
            <span className="shrink-0 text-xs font-medium text-[var(--muted-foreground)]">
              {t('preferences.cli.status.label')}
            </span>
            {!loading && status && !status.needsInstall && (
              <Check className="size-3.5 shrink-0 text-[var(--success)]" />
            )}
            <span className="shrink-0 text-sm text-[var(--foreground)]">{statusText}</span>
            {!loading && (
              <code className="min-w-0 flex-1 truncate text-sm text-[var(--muted-foreground)]" title={status?.commandPath || status?.binDir}>
                {status?.commandPath || status?.binDir || 'flowix'}
              </code>
            )}
            {status?.needsInstall && (
              <Button
                className="shrink-0 px-3"
                onClick={() => void installPath()}
                disabled={installing}
              >
                {installing ? (
                  <Loader2 data-icon="inline-start" className="flowix-spin" />
                ) : (
                  <Download data-icon="inline-start" />
                )}
                {t('preferences.cli.install')}
              </Button>
            )}
          </div>
          {error && (
            <p className="mt-2 text-xs text-[var(--destructive)]">
              {error}
            </p>
          )}
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[42rem] divide-y divide-[var(--divider)]">
            <div className="grid grid-cols-[8rem_minmax(0,1fr)_22rem] items-center gap-4 py-2 text-xs font-medium text-[var(--muted-foreground)]">
              <span>{t('preferences.cli.binary')}</span>
              <span>{t('preferences.cli.description')}</span>
              <span>{t('preferences.cli.example')}</span>
            </div>
            {CLI_COMMANDS.map((item) => (
              <div key={item.command} className="grid grid-cols-[8rem_minmax(0,1fr)_22rem] items-start gap-4 py-2.5">
                <code className="truncate text-sm font-medium text-[var(--foreground)]">
                  {item.command}
                </code>
                <p className="text-sm text-[var(--muted-foreground)]">
                  {t(item.descriptionKey)}
                </p>
                <code className="block whitespace-normal break-words px-2.5 py-1 text-xs text-[var(--foreground)]">
                  {item.usage}
                </code>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
