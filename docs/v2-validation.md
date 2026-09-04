# V2 validation on exactly two real machines

Use Server **S** plus two real Codex computers **A** and **B**. Never copy or upload rollout JSONL or `auth.json` during validation.

1. On S deploy `compose.v2.example.yml`, configure HTTPS, and verify `curl https://meter.example.com/api/v1/health` returns healthy.
2. Sign in and create Groups **A**, **B**, and **C**.
3. Add Device A to Group A, select the Account Profile and login type, and run its one-line installer on machine A. Confirm the Dashboard reaches Tracking or Login required.
4. Add Device B to Group B, explicitly select the intended Account Profile, and install on machine B in the same way.
5. Record each Device and Group measured total. Run real Codex work simultaneously on A and B. Wait one reconciliation plus sync interval and verify both Devices increment independently.
6. Verify Group A plus Group B increments equal the measured Device increments (allow only events still shown as pending by `status`). Group share is a share of measured tokens, not quota consumption.
7. Disconnect A from the network, use Codex on A, and verify `status` reports pending outbox events. Reconnect, wait for sync, and verify the backlog appears once on S.
8. Move Device A to Group C in the Dashboard. Generate one event before and one after the move (disconnect around the move if needed). Reconnect and verify before-move usage remains Group A and after-move usage resolves to Group C.
9. Record totals, restart the Agent on A (`systemctl --user restart codex-meter-agent`, LaunchAgent kickstart, or scheduled-task restart), then verify totals do not duplicate.
10. Restart S with `docker compose restart`, verify health/Dashboard, persistent Groups and Devices, and unchanged totals; generate fresh usage and verify it is accepted.
11. Configure one Device as quota reporter. Inspect Account Quota and its observed/stale state. Disable or disconnect the reporter long enough to cross the stale threshold and verify stale/unavailable labeling.
12. Verify Account Quota remains a separate read-only optional panel and Group usage does not claim exact OpenAI quota attribution.

Capture only numeric totals, timestamps, versions, health states, and redacted IDs in a test report—never raw sessions or credentials.
