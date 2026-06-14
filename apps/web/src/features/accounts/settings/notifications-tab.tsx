'use client';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { isNotificationSupported, sendWebNotification } from '@/lib/web-notifications';
import { useWebNotificationStore } from '@/stores/web-notification-store';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  EyeOff,
  HelpCircle,
  ShieldCheck,
  Volume2,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';

interface NotificationToggleProps {
  icon: LucideIcon;
  label: string;
  description: string;
  enabled: boolean;
  onToggle: (value: boolean) => void;
  disabled?: boolean;
}

function NotificationToggle({
  icon: Icon,
  label,
  description,
  enabled,
  onToggle,
  disabled,
}: NotificationToggleProps) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="flex flex-1 items-start gap-3">
        <Icon className="text-muted-foreground mt-0.5 h-4 w-4" />
        <div className="flex-1 space-y-0.5">
          <Label htmlFor={label} className="cursor-pointer text-sm font-medium">
            {label}
          </Label>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
      </div>
      <Switch id={label} checked={enabled} onCheckedChange={onToggle} disabled={disabled} />
    </div>
  );
}

export function NotificationsTab() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const permission = useWebNotificationStore((s) => s.permission);
  const preferences = useWebNotificationStore((s) => s.preferences);
  const toggleEnabled = useWebNotificationStore((s) => s.toggleEnabled);
  const setPreference = useWebNotificationStore((s) => s.setPreference);
  const syncPermission = useWebNotificationStore((s) => s.syncPermission);

  useEffect(() => {
    syncPermission();
  }, [syncPermission]);

  const supported = isNotificationSupported();

  const handleTestNotification = () => {
    sendWebNotification(
      {
        type: 'completion',
        title: 'Test Notification',
        body: 'Notifications are working correctly!',
        tag: 'test',
      },
      true,
    );
  };

  return (
    <div className="space-y-6 p-6">
      <div>
        <h3 className="text-lg font-semibold">Notifications</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          {tHardcodedUi.raw(
            'componentsSettingsUserSettingsModal.line1075JsxTextConfigureHowAndWhenYouReceiveNotifications',
          )}
        </p>
      </div>

      {!supported ? (
        <div className="rounded-2xl border p-4">
          <p className="text-muted-foreground text-sm">
            {tHardcodedUi.raw(
              'componentsSettingsUserSettingsModal.line1082JsxTextYourBrowserDoesNotSupportNotifications',
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="rounded-2xl border p-4">
            <NotificationToggle
              icon={Bell}
              label={tHardcodedUi.raw(
                'componentsSettingsUserSettingsModal.line1091JsxAttrLabelEnableNotifications',
              )}
              description={
                permission === 'granted'
                  ? 'Browser permission granted'
                  : permission === 'denied'
                    ? 'Blocked by browser — update in browser site settings'
                    : 'Will request browser permission when enabled'
              }
              enabled={preferences.enabled}
              onToggle={() => toggleEnabled()}
            />
          </div>

          {preferences.enabled && (
            <>
              <div>
                <h4 className="mb-3 text-sm font-medium">
                  {tHardcodedUi.raw(
                    'componentsSettingsUserSettingsModal.line1108JsxTextNotificationTypes',
                  )}
                </h4>
                <div className="divide-y rounded-2xl border">
                  <NotificationToggle
                    icon={CheckCircle2}
                    label={tHardcodedUi.raw(
                      'componentsSettingsUserSettingsModal.line1112JsxAttrLabelTaskCompletions',
                    )}
                    description={tHardcodedUi.raw(
                      'componentsSettingsUserSettingsModal.line1113JsxAttrDescriptionWhenASessionFinishesItsTask',
                    )}
                    enabled={preferences.onCompletion}
                    onToggle={(v) => setPreference('onCompletion', v)}
                  />
                  <NotificationToggle
                    icon={AlertTriangle}
                    label="Errors"
                    description={tHardcodedUi.raw(
                      'componentsSettingsUserSettingsModal.line1120JsxAttrDescriptionWhenASessionEncountersAnError',
                    )}
                    enabled={preferences.onError}
                    onToggle={(v) => setPreference('onError', v)}
                  />
                  <NotificationToggle
                    icon={HelpCircle}
                    label="Questions"
                    description={tHardcodedUi.raw(
                      'componentsSettingsUserSettingsModal.line1127JsxAttrDescriptionWhenKortixNeedsYourInputToContinue',
                    )}
                    enabled={preferences.onQuestion}
                    onToggle={(v) => setPreference('onQuestion', v)}
                  />
                  <NotificationToggle
                    icon={ShieldCheck}
                    label={tHardcodedUi.raw(
                      'componentsSettingsUserSettingsModal.line1133JsxAttrLabelPermissionRequests',
                    )}
                    description={tHardcodedUi.raw(
                      'componentsSettingsUserSettingsModal.line1134JsxAttrDescriptionWhenKortixNeedsPermissionToUseATool',
                    )}
                    enabled={preferences.onPermission}
                    onToggle={(v) => setPreference('onPermission', v)}
                  />
                </div>
              </div>

              <div>
                <h4 className="mb-3 text-sm font-medium">Behavior</h4>
                <div className="divide-y rounded-2xl border">
                  <NotificationToggle
                    icon={EyeOff}
                    label={tHardcodedUi.raw(
                      'componentsSettingsUserSettingsModal.line1147JsxAttrLabelOnlyWhenTabIsHidden',
                    )}
                    description={tHardcodedUi.raw(
                      'componentsSettingsUserSettingsModal.line1148JsxAttrDescriptionOnlyNotifyWhenYouReOnAnotherTab',
                    )}
                    enabled={preferences.onlyWhenHidden}
                    onToggle={(v) => setPreference('onlyWhenHidden', v)}
                  />
                  <NotificationToggle
                    icon={Volume2}
                    label={tHardcodedUi.raw(
                      'componentsSettingsUserSettingsModal.line1154JsxAttrLabelNotificationSound',
                    )}
                    description={tHardcodedUi.raw(
                      'componentsSettingsUserSettingsModal.line1155JsxAttrDescriptionPlayASoundWhenANotificationIsSent',
                    )}
                    enabled={preferences.playSound}
                    onToggle={(v) => setPreference('playSound', v)}
                  />
                </div>
              </div>

              <Button onClick={handleTestNotification} variant="outline" size="sm">
                {tHardcodedUi.raw(
                  'componentsSettingsUserSettingsModal.line1164JsxTextSendTestNotification',
                )}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
