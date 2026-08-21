import { config } from '../config';
import { SCOPED_PPWARM_PREFIX, dataPlaneScopeFromSupabaseUrl } from './ppwarm-names';

type ProjectImageScopeConfig = Pick<
  typeof config,
  'SUPABASE_URL' | 'SUPABASE_PUBLIC_URL' | 'INTERNAL_KORTIX_ENV'
>;

type ProjectImageRolloutConfig = ProjectImageScopeConfig &
  Pick<
    typeof config,
    'KORTIX_FAST_COLD_BOOT_CONFIGURED' | 'KORTIX_FAST_COLD_BOOT_ENABLED'
  >;

/** One authoritative ownership scope for every project-image writer and reaper. */
export function currentProjectImageDataPlaneScope(
  settings: ProjectImageScopeConfig = config,
): string {
  const dataPlaneEnvironment =
    settings.INTERNAL_KORTIX_ENV === 'preview' ? 'dev' : settings.INTERNAL_KORTIX_ENV;
  return dataPlaneScopeFromSupabaseUrl(
    settings.SUPABASE_PUBLIC_URL || settings.SUPABASE_URL,
    dataPlaneEnvironment,
  );
}

/** Non-secret fields every API replica logs before it accepts boot traffic. */
export function projectImageRolloutDiagnostic(
  settings: ProjectImageRolloutConfig = config,
): {
  fastConfigured: boolean;
  fastEnabled: boolean;
  projectImageScope: string;
  formatVersion: string;
} {
  return {
    fastConfigured: settings.KORTIX_FAST_COLD_BOOT_CONFIGURED,
    fastEnabled: settings.KORTIX_FAST_COLD_BOOT_ENABLED,
    projectImageScope: currentProjectImageDataPlaneScope(settings),
    formatVersion: SCOPED_PPWARM_PREFIX.slice(0, -1),
  };
}
