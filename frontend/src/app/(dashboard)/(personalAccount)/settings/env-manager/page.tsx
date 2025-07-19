import { isLocalMode } from "@/lib/config";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Shield } from "lucide-react";
import { LocalEnvManager } from "@/components/env-manager/local-env-manager";

export default function LocalEnvManagerPage() {

  return <LocalEnvManager />
}