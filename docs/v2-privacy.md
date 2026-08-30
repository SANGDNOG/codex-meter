# V2 privacy model

The local parser is an explicit allowlist. It emits only timestamp; input, cached-input, optional cache-write-input, output, reasoning-output, and total token counts; and structurally bounded model/reasoning-effort metadata. It rejects lookalike fields and does not preserve raw JSONL.

Prompts, messages, responses, source code, tool arguments, tool outputs, cwd, paths, repository names, arbitrary payload fields, OAuth credentials, and `auth.json` are never persisted or transmitted. Raw rejected lines are never logged. Device secrets and administrator passwords are hash-protected server-side; the Device secret is returned only at enrollment/rotation and the local config is permission-restricted.

Never upload rollout JSONL or `auth.json` in bug reports, chat, CI artifacts, backups, or support requests. Share sanitized health/status output only after checking it contains no local path or credential.

Existing files are baselined at installation. Recognized inherited histories are skipped. If inherited history in a new file cannot be separated safely, Codex Meter baselines the ambiguous file. This can undercount safely; it intentionally avoids privacy-heavy global lineage reconstruction and double counting.