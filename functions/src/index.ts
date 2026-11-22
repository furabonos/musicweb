import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { health } from './api/health.js';
export { account } from './api/account.js';
export { admin } from './api/admin.js';
export { playlists } from './api/playlists.js';
export { ingestNightly, purgeNightly, refreshNightly } from './jobs/schedules.js';
