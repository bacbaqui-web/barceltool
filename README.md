# 빠툴 · barcel_tool

로컬 이미지 폴더를 빠르게 탐색하고 관리하는 브라우저 도구입니다.

## 주요 기능

- 메타데이터 우선 점진 로딩과 화면 우선 이미지 Queue
- Masonry Gallery와 Virtual Scrolling
- 직접 이미지 개수가 표시되는 폴더 트리와 하위 폴더 포함 ON/OFF 보기
- 다중 선택과 Space 미리보기
- 이미지 이동, 자체 휴지통, 영구 삭제
- 숫자 1~9와 동적 폴더 슬롯을 이용한 빠른 이동 분류 모드
- 미리보기 파일명 변경과 가로·세로 맞춤
- 라이트·다크모드

## 실행

File System Access API를 지원하는 Chrome 또는 Edge를 사용하세요.

```bash
python3 -m http.server 8765
```

브라우저에서 `http://127.0.0.1:8765`를 열고 `폴더 불러오기`를 누르면 됩니다. 선택한 파일은 서버로 업로드되지 않으며 브라우저에서 직접 처리됩니다.

상세한 현재 구조와 안전 원칙은 [TASK_CONTEXT.md](./TASK_CONTEXT.md)를 참고하세요.
