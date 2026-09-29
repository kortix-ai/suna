// Side-effect entry for the gateway routes: importing it registers every
// gateway route on `projectsApp` exactly once. The routes live in focused
// sibling modules.
import './gateway-logs';
import './gateway-spend';
import './gateway-keys';
import './gateway-playground';
import './gateway-providers';
import './gateway-routing-policy';
