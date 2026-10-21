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
          className="flowix-loading-ring flowix-spin"
          aria-hidden="true"
        />
        {label && <span>{label}</span>}
      </div>
    </div>
  );
}
