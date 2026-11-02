'use client';

import { CliSection } from '@features/preferences/sections/cli';
import { McpSection } from '@features/preferences/sections/mcp';

export function McpPreferencesTab() {
  return (
    <div className="space-y-8">
      <McpSection />
      <CliSection />
    </div>
  );
}
