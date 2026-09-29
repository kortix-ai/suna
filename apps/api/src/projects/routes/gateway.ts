// Side-effect entry for the gateway routes. Each focused sibling module below
// registers its own routes on `projectsApp`; importing this module keeps the
// existing `import './routes/gateway'` in projects/index.ts wiring all of them.
import './gateway-logs';
import './gateway-spend';
import './gateway-keys';
import './gateway-playground';
import './gateway-providers';
import './gateway-routing-policy';
