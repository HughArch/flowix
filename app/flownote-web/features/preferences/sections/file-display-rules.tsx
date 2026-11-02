'use client';

import { FileManagementSection } from './file-management';

export function FileDisplayRulesSection({ hideSectionHeader = false }: { hideSectionHeader?: boolean }) {
  return <FileManagementSection hideSectionHeader={hideSectionHeader} />;
}
