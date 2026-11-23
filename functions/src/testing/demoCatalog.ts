import { compareKey } from '@musicweb/shared';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { DEMO_SONGS } from '@musicweb/shared/demo';

/** 가짜 곡 목록을 에뮬레이터 Firestore에 넣는다(통합 테스트용, tools/seed-emulator.ts와 같은 내용). */
export async function seedDemoCatalog(db: Firestore, verifiedAt = new Date()) {
  const batch = db.batch();
  for (const s of DEMO_SONGS) {
    const ref = db.doc(`songs/${s.mbid}`);
    batch.set(ref, {
      mbid: s.mbid,
      artist: s.artist,
      artistMbid: s.artistMbid,
      title: s.title,
      key: s.key,
      titleKey: compareKey(s.title),
      releaseYear: s.releaseYear,
      source: 'demo',
    });
    batch.set(ref.collection('links').doc(s.videoId), {
      videoId: s.videoId,
      kind: 'official_audio',
      status: 'active',
      linkedBy: 'demo',
      ytTitle: `${s.artist} - ${s.title} (demo)`,
      channelId: 'UCdemo0000000000000000',
      embeddable: true,
      madeForKids: false,
      durationSec: 180,
      verifiedAt: Timestamp.fromDate(verifiedAt),
    });
  }
  await batch.commit();
}
