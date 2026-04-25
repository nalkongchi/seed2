# seed_training_v1.2_true_starter

이 starter는 **홈 화면을 이미지 레이어 방식으로 바꿔놓은 1.2 시작본**이야.

## 포함된 구조
- `index.html`
- `css/style.css`
- `js/data.js`
- `js/app.js`
- `images/home/`
- `audio/`

## 홈 이미지 넣는 위치
아래 파일명을 그대로 써서 넣으면 바로 연결돼.
- `images/home/home_bg.png`
- `images/home/home_title.png`
- `images/home/home_roulette.png`
- `images/home/btn_home_time.png`
- `images/home/btn_home_practice.png`
- `images/home/btn_home_wrong.png`
- `images/home/btn_home_settings.png`

## 오디오 넣는 위치
- `audio/bgm_home.mp3`
- `audio/bgm_play.mp3`
- `audio/se_correct.wav`
- `audio/se_wrong.wav`
- `audio/se_finish.wav`

## 홈 화면 동작 원리
- 배경: 이미지 레이어
- 타이틀: 이미지 레이어
- 룰렛: 이미지 레이어
- 버튼: 실제 `<button>` 안에 이미지 `<img>`

이미지가 아직 없으면 starter가 깨지지 않도록 **자리 표시용 박스**가 보이게 해뒀어.
이미지를 넣으면 해당 박스는 자동으로 사라져.

## 현재 방향
- 홈: 이미지 중심 구조로 전환
- 플레이/결과/팝업: 기존 1.1 로직 유지
- 오디오: 파일명 규칙만 잡고 바로 꽂을 수 있게 연결


## 이번 버전 변경
- 홈 플레이스홀더 글씨는 이미지가 정상 로드되면 자동으로 숨김
- 홈 배치는 1안(타이틀 > 룰렛 > 큰 버튼 2개 > 작은 버튼 2개) 기준으로 조정
- 설정 버튼은 오답노트와 동일한 작은 버튼 규격으로 맞춤
