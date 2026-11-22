import { beforeEach, describe, expect, it } from 'vitest';
import { seedDemoCatalog } from '../testing/demoCatalog.js';
import { clearFirestore, DAY_MS, emulatorDb } from '../testing/emulator.js';
import { memoryEvents } from '../testing/music.js';
import { firestoreLinkHealthPorts, runLinkHealth } from './linkHealth.js';

const db = emulatorDb();
beforeEach(clearFirestore);

describe('linkHealth — Firestore 포트', () => {
  it('곡 목록의 지금 쓰는 영상 2개로 확인하고, 깨지면 config/runtime.youtubeOpenLink=fallback, 다른 설정은 그대로', async () => {
    await seedDemoCatalog(db);
    await db.doc('config/runtime').set({ killSwitches: { create: false } });
    const checked: string[][] = [];
    const ports = firestoreLinkHealthPorts(db, {
      check: async (ids) => {
        checked.push(ids);
        return { status: 200, listOk: false };
      },
      events: memoryEvents().sink,
    });
    expect(await runLinkHealth(ports)).toBe('broken');
    expect(checked[0]).toHaveLength(2);
    expect(checked[0]?.every((v) => v.startsWith('demoVid'))).toBe(true);
    expect((await db.doc('config/runtime').get()).data()).toEqual({
      killSwitches: { create: false },
      youtubeOpenLink: 'fallback',
    });
    const log = (await db.collection('opsLog').get()).docs.map((d) => d.data());
    expect(log).toEqual([expect.objectContaining({ kind: 'issue' })]);
  });

  it('25일 넘게 확인 안 된 연결은 쓰지 않음 → 확인 건너뜀', async () => {
    await seedDemoCatalog(db, new Date(Date.now() - 26 * DAY_MS));
    let called = false;
    const ports = firestoreLinkHealthPorts(db, {
      check: async () => {
        called = true;
        return { status: 303, listOk: true };
      },
      events: memoryEvents().sink,
    });
    expect(await runLinkHealth(ports)).toBe('skipped');
    expect(called).toBe(false);
  });
});
