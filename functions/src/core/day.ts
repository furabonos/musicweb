/**
 * 사용량 집계 날짜. YouTube Data API 할당량이 태평양 시간 자정에 초기화되므로 같은 기준을 쓴다 (SPEC 6.3).
 * 결과 형식: "YYYY-MM-DD".
 */
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function pacificDay(now: Date): string {
  return formatter.format(now);
}

/**
 * now 다음에 오는 태평양 자정(= 사용량 초기화 시각). 서머타임으로 하루가 23·25시간인 날도 맞게,
 * 날짜가 바뀌는 첫 시각을 1초 단위로 찾는다.
 */
export function nextPacificMidnight(now: Date): Date {
  const today = pacificDay(now);
  let lo = now.getTime(); // 아직 오늘
  let hi = lo + 26 * 3600 * 1000; // 확실히 다음 날 이후
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (pacificDay(new Date(mid)) === today) lo = mid;
    else hi = mid;
  }
  // lo < 자정 <= hi, hi - lo <= 1초 이고 자정은 정각 초이므로 내림이 정확한 자정이다.
  return new Date(Math.floor(hi / 1000) * 1000);
}
