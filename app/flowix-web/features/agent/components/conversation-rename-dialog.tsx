'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { useI18n } from '@/lib/i18n';

/** Small rename dialog shared by the mobile drawer and the conversations list. */
export function ConversationRenameDialog({
  open,
  initialTitle,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  initialTitle: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (title: string) => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(initialTitle);

  useEffect(() => {
    if (open) setTitle(initialTitle);
  }, [open, initialTitle]);

  const trimmed = title.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('agent.mobilePanel.renameConversation')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 px-1 pb-1">
          <Input
            autoFocus
            value={title}
            placeholder={t('agent.mobilePanel.renamePlaceholder')}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !trimmed) return;
              onSubmit(trimmed);
              onOpenChange(false);
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={!trimmed}
              onClick={() => {
                onSubmit(trimmed);
                onOpenChange(false);
              }}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
