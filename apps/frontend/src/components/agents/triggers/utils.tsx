// Replaced with lucide-react for smaller bundle
import { Send as FaTelegram } from "lucide-react";
import { SlackIcon } from "@/components/ui/icons/slack";
import { Webhook, Clock } from "lucide-react";
import { Zap } from "lucide-react";

export const getTriggerIcon = (triggerType: string) => {
  switch (triggerType) {
    case 'telegram':
      return <FaTelegram className="h-5 w-5" color="#0088cc" />;
    case 'slack':
      return <SlackIcon className="h-5 w-5" />;
    case 'webhook':
      return <Webhook className="h-5 w-5" />;
    case 'schedule':
      return <Clock className="h-5 w-5" color="#10b981" />;
    default:
      return <Zap className="h-5 w-5" />;
  }
};

export const getDialogIcon = (triggerType: string) => {
  switch (triggerType) {
    case 'telegram':
      return <FaTelegram className="h-6 w-6" color="#0088cc" />;
    case 'slack':
      return <SlackIcon className="h-6 w-6" />;
    case 'webhook':
      return <Webhook className="h-6 w-6" />;
    case 'schedule':
      return <Clock className="h-6 w-6" color="#10b981" />;
    default:
      return <Zap className="h-5 w-5" />;
  }
};