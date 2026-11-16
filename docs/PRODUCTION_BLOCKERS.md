# Production blockers

Anineko is **NOT READY** for public exposure.

1. Configure and verify the provider-specific `HLS_ALLOWED_HOSTS` list on the Pi. Empty configuration fails closed; an incomplete list causes provider playback regressions.
2. Resolve the Cloudflare Worker DNS-rebinding limitation. Worker `fetch()` does not expose connection-time DNS pinning in this implementation. Either verify Cloudflare blocks private-address resolution for outbound Worker requests, place outbound proxying behind a runtime that can pin DNS, or remove public Worker HLS proxy routes only after proving no production playback path depends on them.
3. Run the full proxy and route tests after environment configuration; run E2E only when the required local services are actually running.
4. Verify the Pi runs Node >=22.23.4, supports the selected native dependencies on ARM64, and has the required service resource limits and storage mount.
5. Verify the real resolver host inventory for all enabled providers. The domains currently listed in `.env.example` are observed sample hosts, not a complete inventory.
6. Test Docker/ARM64 image build and runtime resource/restart behavior. No container deployment has been validated.
7. Perform live Pi smoke tests, backups and restore verification. No Pi changes or deployment were made in this phase.
