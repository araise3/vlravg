/**
 * Replay import routes under /api/replays/ (docs/replay-import.md). Kept out
 * of the HenrikDev proxy in functions/api/[[path]].js: nothing here calls
 * HenrikDev, and nothing here writes the trusted evidence tables.
 *
 * BINDINGS (Pages project → Settings):
 *   REPLAY_BUCKET (R2)            raw uploads (raw/) and compact results (compact/)
 *   APP_DB (D1)                   replay_imports, replay_import_parts, replay_import_quota
 *   TURNSTILE_SITE_KEY, TURNSTILE_SECRET   upload verification
 *   HENRIK_WORKFLOW_KEY (Secret)  authenticates the parser workflow
 *   GITHUB_DISPATCH_TOKEN (Secret, optional)  fine-grained token with only
 *                                 Actions: write on this repository; starts
 *                                 .github/workflows/parse-replays.yml
 *   REPLAY_UPLOADS_DISABLED=1     kill switch for new uploads
 */
import { handleReplayRequest } from '../../../lib/replay-import.mjs';

export async function onRequest(context) {
  const path = new URL(context.request.url).pathname.replace(/^\/api\/replays/, '') || '/';
  return handleReplayRequest(context, path);
}
