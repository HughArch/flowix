'use client';

import { useEffect, useState } from 'react';
import { Check, Cloud, Info } from 'lucide-react';

import googleLogo from '@/assets/google.svg';
import { errorMessage } from '@/lib/error-message';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { openUrl } from '@platform/tauri/opener';
import { cloudSyncErrorMessage } from '@platform/tauri/errors';
import { subscribe } from '@platform/tauri/event-bus';
import {
  cloud,
  type CloudProduct,
  type CloudState,
} from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { cn } from '@/lib/utils';
import { useCloudAccountState } from '@features/preferences/hooks/use-cloud-account-state';

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatStorageCapacity(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let capacity = value;
  let unitIndex = 0;
  while (capacity >= 1024 && unitIndex < units.length - 1) {
    capacity /= 1024;
    unitIndex += 1;
  }
  const formatted = Number.isInteger(capacity) ? String(capacity) : capacity.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

function productPlan(product: CloudProduct): 'go' | 'pro' | null {
  const capacity = formatStorageCapacity(product.entitlement.storageBytes);
  const productText = `${product.name} ${product.description}`.toLowerCase();
  if (capacity === '200 MB' || /flowix\s*go/.test(productText)) return 'go';
  if (capacity === '2 GB' || /flowix\s*pro/.test(productText)) return 'pro';
  return null;
}

type BillingPeriod = 'monthly' | 'yearly';

function productBillingPeriod(product: CloudProduct): BillingPeriod | null {
  const { unit, count } = product.entitlement.duration;
  const normalizedUnit = unit.trim().toLowerCase();

  if (
    normalizedUnit.includes('year')
    || (normalizedUnit.includes('month') && count >= 12)
    || (normalizedUnit.includes('day') && count >= 360)
  ) {
    return 'yearly';
  }
  if (normalizedUnit.includes('month') || (normalizedUnit.includes('day') && count >= 28 && count <= 31)) {
    return 'monthly';
  }

  const productText = `${product.name} ${product.description}`.toLowerCase();
  if (/year|annual|每年|按年/.test(productText)) return 'yearly';
  if (/month|monthly|每月|按月/.test(productText)) return 'monthly';
  return null;
}

export function CloudSyncSection() {
  const { t } = useI18n();
  const { state, loadError: stateLoadError, loading: loadingLoginState, applyState, membershipLoading, membershipError, refreshMembership } = useCloudAccountState();
  const [products, setProducts] = useState<CloudProduct[]>([]);
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('monthly');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [productsLoadError, setProductsLoadError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void cloud.listProducts().then((next) => {
      if (active) setProducts(next);
    }).catch((error) => {
      if (active) setProductsLoadError(errorMessage(error));
    });
    return () => { active = false; };
  }, []);

  const run = async (task: () => Promise<CloudState>) => {
    setBusy(true);
    try {
      const next = await task();
      applyState(next);
      setPassword('');
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const submitLegacyLogin = () => {
    if (loadingLoginState || busy || state?.authenticated || !email.trim() || !password) return;
    void run(() => cloud.login(email.trim(), password));
  };

  const startGoogleSignIn = async () => {
    if (loadingLoginState || busy || state?.authenticated) return;
    setBusy(true);
    try {
      await cloud.startGoogleSignIn();
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => subscribe<string>('cloud-google-auth-error', (message) => {
    toast.error(cloudSyncErrorMessage(message, t));
  }), [t]);

  return (
    <div className="space-y-5 pb-8">
      <SectionHeader title={t('preferences.cloud.title')} description={t('preferences.cloud.description')} />

      {(stateLoadError ?? state?.authError) && (
        <p className="break-words text-sm text-[var(--destructive)]">
          {stateLoadError ?? state?.authError}
        </p>
      )}

      {!state?.authenticated ? (
        <div className="space-y-4">
          <div id="cloud-email-login" className="space-y-3">
            <Input
              type="email"
              className="mx-auto h-10 w-[64%] rounded-lg bg-[var(--card)]"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t('preferences.cloud.email')}
              autoComplete="username"
            />
            <Input
              type="password"
              className="mx-auto h-10 w-[64%] rounded-lg bg-[var(--card)]"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitLegacyLogin();
              }}
              placeholder={t('preferences.cloud.password')}
              autoComplete="current-password"
            />
            <Button
              className="mx-auto flex h-10 w-[64%] rounded-lg"
              disabled={loadingLoginState || busy || !email.trim() || !password}
              onClick={submitLegacyLogin}
            >
              {loadingLoginState
                ? t('preferences.cloud.loading')
                : busy
                ? t('preferences.cloud.loggingIn')
                : t('preferences.cloud.login')}
            </Button>
          </div>
          <div className="flex items-center gap-3 text-xs text-[var(--muted-foreground)]">
            <span className="h-px flex-1 bg-[var(--border)]" />
            <span>{t('preferences.cloud.orContinueWith')}</span>
            <span className="h-px flex-1 bg-[var(--border)]" />
          </div>
          <Button
            variant="outline"
            className="mx-auto flex h-10 w-[64%] gap-2 rounded-lg bg-[var(--card)]"
            disabled={loadingLoginState || busy}
            onClick={() => void startGoogleSignIn()}
          >
            <img src={googleLogo} alt="" aria-hidden="true" className="h-4 w-4 object-contain" />
            {t('preferences.cloud.googleSignIn')}
          </Button>
        </div>
      ) : (
        <>
          <div className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--muted)]">
                <Cloud className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {state.account?.user.displayName}
                </div>
                <div className="truncate text-xs text-[var(--muted-foreground)]">
                  {state.account?.user.email}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  disabled={busy}
                  onClick={() => void run(() => cloud.logout())}
                >
                  {t('preferences.cloud.logout')}
                </Button>
              </div>
            </div>

            <div className="space-y-3 border-t border-[var(--border)] pt-4">
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium">{t('preferences.cloud.membership')}</div>
                {state.membership && <span className={cn(
                  'rounded-full px-2 py-0.5 text-xs',
                  state.membership?.active
                    ? 'bg-[color-mix(in_oklch,var(--success)_15%,transparent)] text-[var(--success)]'
                    : 'bg-[color-mix(in_oklch,var(--warning)_15%,transparent)] text-[var(--warning)]',
                )}>
                  {state.membership?.active
                    ? t('preferences.cloud.active')
                    : t('preferences.cloud.inactive')}
                </span>}
              </div>
              {membershipLoading && <p className="text-xs text-[var(--muted-foreground)]">{t('preferences.cloud.membershipLoading')}</p>}
              {membershipError && <div className="space-y-2">
                <p className="text-xs text-[var(--destructive)]">{t('preferences.cloud.membershipFailed')}: {membershipError}</p>
                <Button variant="outline" className="px-3" disabled={membershipLoading} onClick={() => void refreshMembership()}>
                  {t('preferences.cloud.retry')}
                </Button>
              </div>}
              {state.membership && <div className="text-sm text-[var(--muted-foreground)]">
                {t('preferences.cloud.usage')}: {formatBytes(state.membership?.usedBytes ?? 0)}
                {' / '}
                {formatBytes(state.membership?.quotaBytes ?? 0)}
              </div>}
              {state.membership?.expiresAt && (
                <div className="text-xs text-[var(--muted-foreground)]">
                  {t('preferences.cloud.expires')}:{' '}
                  {new Date(state.membership.expiresAt).toLocaleDateString()}
                </div>
              )}
            </div>
          </div>


          <div className="space-y-3">
            <div className="text-sm font-medium">{t('preferences.cloud.plans')}</div>
            <div
              role="tablist"
              aria-label={t('preferences.cloud.plans')}
              className="relative inline-flex h-9 shrink-0 items-center gap-0.5 rounded-xl border border-[var(--border)] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] px-0.5 py-0"
            >
              {(['monthly', 'yearly'] as const).map((period) => (
                <button
                  key={period}
                  type="button"
                  role="tab"
                  aria-selected={billingPeriod === period}
                  tabIndex={billingPeriod === period ? 0 : -1}
                  className={cn(
                    'relative flex h-[30px] items-center justify-center rounded-lg px-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]',
                    billingPeriod === period
                      ? 'border border-[var(--border)] bg-[var(--card)] text-[var(--primary)]'
                      : 'border border-transparent text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]',
                  )}
                  onClick={() => setBillingPeriod(period)}
                >
                  {t(`preferences.cloud.${period}`)}
                </button>
              ))}
            </div>
            {productsLoadError && (
              <p className="break-words text-sm text-[var(--destructive)]">
                {productsLoadError}
              </p>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {products.filter((product) => productBillingPeriod(product) === billingPeriod).map((product) => {
                const plan = productPlan(product);
                const storageCapacity = formatStorageCapacity(product.entitlement.storageBytes);
                const [storagePrefix, storageSuffix] = t('preferences.cloud.totalStorage', { capacity: storageCapacity }).split(storageCapacity);

                return (
                  <div
                    key={product.id}
                    className="flex h-full min-h-[520px] flex-col rounded-xl border border-[var(--border)] bg-[var(--card)] p-2.5 pt-4 transition-colors hover:border-[var(--primary)]/40 sm:p-3 sm:pt-[18px]"
                  >
                    <div className="min-h-14 min-w-0">
                      <div className="text-[22px] font-semibold leading-7 tracking-tight text-[var(--foreground)]">
                        {plan
                          ? t(`preferences.cloud.plan.${plan}.name`)
                          : product.name}
                      </div>
                      {plan && (
                        <div className="mt-1.5 text-[13px] leading-5 text-[var(--muted-foreground)]">
                          {t(`preferences.cloud.plan.${plan}.subtitle`)}
                        </div>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[var(--foreground)]" style={{ fontFamily: 'var(--code-text-font-family)' }}>
                      <span className="text-[32px] font-semibold leading-10 tracking-tight tabular-nums">
                        ${(product.price.amount / 100).toFixed(2)}
                      </span>
                      <span className="text-[13px] leading-5 text-[var(--muted-foreground)]">
                        {t(`preferences.cloud.pricePeriod.${billingPeriod}`)}
                      </span>
                    </div>
                    <div className="my-5 border-t border-[var(--border)]" />
                    <div className="mb-3 text-[13px] font-medium leading-5 text-[var(--foreground)]">
                      {t('preferences.cloud.plan.includes')}
                    </div>
                    <ul className="space-y-2.5 text-[13px] leading-5 text-[var(--muted-foreground)]">
                      <li className="flex items-start gap-1.5">
                        <Check className="mt-1 h-3 w-3 shrink-0" aria-hidden="true" />
                      <span>
                        {storagePrefix}<span className="font-medium text-[var(--brand)]">{storageCapacity}</span>{storageSuffix}
                      </span>
                      </li>
                      <li className="flex items-start gap-1.5">
                        <Check className="mt-1 h-3 w-3 shrink-0" aria-hidden="true" />
                        <span>{t('preferences.cloud.unlimitedSyncedNotebooks')}</span>
                      </li>
                      <li className="flex items-start gap-1.5">
                        <Check className="mt-1 h-3 w-3 shrink-0" aria-hidden="true" />
                        <span>{t('preferences.cloud.maximumFileSize', { size: '5 MB' })}</span>
                      </li>
                      {([
                        'piByok',
                        'localAgents',
                        'mcpCli',
                        'earlyAccess',
                      ] as const).map((benefit) => (
                        <li key={benefit} className="flex items-start gap-1.5">
                          <Check className="mt-1 h-3 w-3 shrink-0" aria-hidden="true" />
                          <span>{t(`preferences.cloud.plan.benefit.${benefit}`)}</span>
                          {benefit === 'localAgents' && (
                            <div className="-ml-1.5">
                              <Popover>
                                <PopoverTrigger asChild>
                                  <button
                                    type="button"
                                    aria-label={t('preferences.cloud.plan.benefit.localAgentsInfo')}
                                    className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
                                  >
                                    <Info className="h-3 w-3" aria-hidden="true" />
                                  </button>
                                </PopoverTrigger>
                                <PopoverContent side="top" align="center" className="max-w-[240px] px-3 py-2 text-xs leading-5">
                                  {t('preferences.cloud.plan.benefit.localAgentsInfo')}
                                </PopoverContent>
                              </Popover>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-auto pt-6">
                      <Button
                        size="lg"
                        className="h-10 w-full rounded-xl bg-[var(--brand)] text-[13px] font-medium text-[var(--primary-foreground)] hover:bg-[color-mix(in_oklch,var(--brand)_90%,black)]"
                        disabled={busy}
                        onClick={() => {
                          setBusy(true);
                          void cloud.createCheckout(product.id)
                            .then((checkout) => openUrl(checkout.checkoutUrl))
                            .catch((error) => toast.error(errorMessage(error)))
                            .finally(() => setBusy(false));
                        }}
                      >
                      {plan ? t(`preferences.cloud.plan.${plan}.get`) : t('preferences.cloud.buy')}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            {!productsLoadError && products.length > 0 && !products.some((product) => productBillingPeriod(product) === billingPeriod) && (
              <p className="text-sm text-[var(--muted-foreground)]">{t('preferences.cloud.noPlansForPeriod')}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
