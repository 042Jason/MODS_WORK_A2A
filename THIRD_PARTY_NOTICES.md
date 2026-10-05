# 외부 구성요소 고지

이 저장소에는 아래 외부 구성요소가 함께 들어 있거나 설치되어 쓰입니다. 각 구성요소의 저작권은 해당 저작자에게 있고, 각자의 라이선스를 따릅니다. 라이선스 원문은 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)에 있습니다.

| 구성요소 | 위치 | 쓰임새 | 저작권 | 라이선스 |
|---|---|---|---|---|
| pdf.js 3.11.174 | `vendor/pdf.min.js`, `vendor/pdf.worker.min.js` | PDF 자료 읽기 | Mozilla Foundation | Apache License 2.0 |
| SheetJS Community Edition | `vendor/xlsx.full.min.js` | 엑셀·CSV 자료 읽기 | SheetJS LLC | Apache License 2.0 |
| mammoth.js | `vendor/mammoth.browser.min.js` | 워드(.docx) 자료 읽기 | Michael Williamson | BSD 2-Clause |
| JSZip 3.10.1 (pako 포함) | `vendor/jszip.min.js` | HWPX 압축 풀기 | Stuart Knightley 외 / Vitaly Puzrin, Andrei Tuputcyn | MIT (이중 라이선스 중 MIT 선택) |
| Pretendard Variable | `vendor/fonts/PretendardVariable.woff2` | 본문 글꼴 | Kil Hyung-jin | SIL Open Font License 1.1 |
| JetBrains Mono | `vendor/fonts/JetBrainsMono-500.woff2` | 고정폭 글꼴 | The JetBrains Mono Project Authors | SIL Open Font License 1.1 |
| @vercel/blob | `package.json` 의존성 (배포 때 설치) | 결과 공유 링크 저장 | Vercel, Inc. | Apache License 2.0 |

글꼴은 라이선스에 따라 원본 그대로 함께 배포하며, 글꼴 자체를 판매하지 않습니다.

## 외부 서비스
- OpenRouter 및 각 AI 모델 제공사의 API를 호출해 답을 만듭니다. 이용자는 각 서비스의 약관을 따라야 합니다.
- 호스팅: Vercel
