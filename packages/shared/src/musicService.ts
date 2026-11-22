/**
 * 재생 서비스 인터페이스 (SPEC 4.5, 4.6, D-003, D-032). 구현체는 YouTube 하나(apps/web/src/player/youtube.ts).
 * 화면 코드에 DOM 타입을 강요하지 않도록 붙일 자리(Container)는 구현체가 정한다.
 */
export interface PlayerEvents {
  /** 곡이 끝남 */
  onEnded(): void;
  /** 재생 오류(YouTube: 2·5·100·101·150) */
  onError(code: number): void;
}

export interface MusicPlayer {
  /** 영상을 올려만 둔다(재생은 사용자가 누를 때) */
  cue(videoId: string): void;
  /** 영상을 바로 재생한다(사용자 클릭 뒤, 또는 다음 곡 자동 진행) */
  play(videoId: string): void;
  destroy(): void;
}

export interface MusicService<Container> {
  readonly name: 'youtube';
  mount(container: Container, events: PlayerEvents): Promise<MusicPlayer>;
}
