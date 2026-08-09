Fix sandbox lifecycle ownership and idle billing

Sandbox lifetime is now agent-bound. Active agent turns keep compute alive. Terminal or inactive sessions contract to a 15-minute retrieval window. Wake billing starts only after provider-running confirmation. Concurrent and failed wakes are bounded, manual stop cancels wake claims, and maintenance stops late provider starts. The change includes SDK terminal polling behavior, closed stop reasons, provider conflict handling, migration support, and real Platinum billing and PTY coverage.
