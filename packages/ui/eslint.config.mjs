// The session UI moved here from apps/web, so it keeps the apps/web rules:
// the SDK boundary, the query-key and icon import rules, the nav contract.
import { sharedConfig, sdkBoundaryConfig } from '../../scripts/eslint/shared-config.mjs';

export default [...sharedConfig, sdkBoundaryConfig];
