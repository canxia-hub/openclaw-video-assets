# Dreamina CLI Official Guide Notes

Read on 2026-06-25 from the Lark Wiki page titled `即梦 CLI 体验指南`.

Key points:

- The CLI supports local automation for image generation, video generation, result query, task history, account query, and sessions.
- Most generation work is asynchronous. Save submit ids and query results later rather than submitting duplicates.
- Account and credit checks are zero-cost and should run before every real generation.
- Sessions can isolate tasks by project.
- Troubleshooting starts with the exact command, error text, and local CLI logs.
- The OpenClaw video-assets plugin exposes `video_canvas_dreamina_cli_plan` as the non-spending planning method for infinite canvas generation handoff.
