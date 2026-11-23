import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { health } from './api/health.js';
export { account } from './api/account.js';
export { admin } from './api/admin.js';
export { playlists, site } from './api/playlists.js';
export { playback } from './api/playback.js';
export { status } from './api/status.js';
export {
  autoIssueNightly,
  dailyEvalNightly,
  githubStatsNightly,
  ingestNightly,
  linkHealthNightly,
  metricsNightly,
  purgeNightly,
  refreshNightly,
} from './jobs/schedules.js';
