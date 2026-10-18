'use client';

import type { ProductInfo } from '@platform/tauri/client';
import { EnvironmentConfigSection } from '@features/preferences/sections/environment-config';

export function EnvironmentConfigPreferencesTab({ productInfo = null }: { productInfo?: ProductInfo | null }) {
  return <EnvironmentConfigSection productInfo={productInfo} />;
}
