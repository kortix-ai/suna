// Empty module used by metro.config.js to stub Node.js built-ins that leak into
// the bundle graph through third-party packages but are never exercised at
// runtime in React Native (e.g. `readline` pulled in via expensify-common's
// CLI helper, which react-native-live-markdown transitively references).
module.exports = {};
