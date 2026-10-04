import { DevelopersCli } from '@/features/marketing/developers/cli';
import { DevelopersClosing } from '@/features/marketing/developers/closing';
import { DevelopersConnectors } from '@/features/marketing/developers/connectors';
import { DevelopersHero } from '@/features/marketing/developers/hero';
import { DevelopersLoop } from '@/features/marketing/developers/loop';
import { DevelopersScale } from '@/features/marketing/developers/scale';
import { DevelopersThesis } from '@/features/marketing/developers/thesis';

export default function DevelopersPage() {
  return (
    <div className="bg-background relative w-full overflow-x-clip">
      <DevelopersHero />
      <DevelopersThesis />
      <DevelopersLoop />
      <DevelopersScale />
      <DevelopersCli />
      <DevelopersConnectors />
      <DevelopersClosing />
    </div>
  );
}
