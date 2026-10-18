import { useI18n } from '@/lib/i18n';

interface CenteredLoadingSpinnerProps {
  className?: string;
  ariaLabel?: string;
  label?: string;
}

export function CenteredLoadingSpinner({
  className = '',
  ariaLabel,
  label,
}: CenteredLoadingSpinnerProps) {
  const { t } = useI18n();
  return (
    <div
      className={`flex items-center justify-center ${className}`}
      role="status"
      aria-label={ariaLabel ?? t('memo.navigation.loading')}
    >
      <div className="flex flex-col items-center gap-3 text-sm text-[var(--muted-foreground)]">
        <div
          className="h-5 w-5 flowix-spin rounded-full border-2 border-[color-mix(in_oklch,var(--muted-foreground)_26%,transparent)] border-t-[var(--brand)]"
          aria-hidden="true"
        />
        {label && <span>{label}</span>}
      </div>
    </div>
  );
}
