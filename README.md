# 한국주식 대시보드

코스피·코스닥 지수와 종목 순위(상승률·하락률·거래대금·거래량·시가총액), 업종별 등락을
한 화면에서 보는 정적 사이트. GitHub Pages로 배포된다.

## 어떻게 도는가

브라우저에서 증권 API를 직접 부르면 CORS에 막힌다. 그래서 **수집은 GitHub Actions(서버)가
하고, 페이지는 구워진 JSON만 읽는다.**

```
GitHub Actions (5분마다)
   └ node scripts/fetch.js        네이버 금융 공개 JSON 엔드포인트 수집
        └ public/data/*.json      정적 데이터로 굽기
             └ actions/deploy-pages   Pages로 배포 (저장소에 커밋하지 않음)
                  └ 브라우저가 data/*.json 만 fetch
```

- API 키가 필요 없다. 따라서 노출될 비밀도 없다.
- 데이터를 저장소에 커밋하지 않으므로 5분 주기여도 커밋 히스토리가 더러워지지 않는다.
- `public/data/*.json`은 `.gitignore` 대상이다. 로컬에서 보려면 직접 한 번 생성해야 한다.

## 로컬에서 보기

```bash
node scripts/fetch.js                 # public/data/{market,stocks}.json 생성 (약 6초)
npx serve public                      # 또는 아무 정적 서버
```

`file://`로 열면 `fetch`가 막히므로 반드시 정적 서버로 띄운다.

## 갱신 주기

`.github/workflows/update.yml`의 cron은 UTC 기준이다(KST = UTC+9).

| cron | 실제 시각(KST) | 용도 |
|---|---|---|
| `*/5 0-6 * * 1-5` | 평일 09:00~15:55, 5분 간격 | 장중 |
| `10 7 * * 1-5` | 평일 16:10 | 마감 확정치 |

GitHub Actions의 cron은 정시성이 보장되지 않아 **몇 분 늦게 실행될 수 있다.** 화면 우상단에
표시되는 "기준 시각"이 실제 수집 시각이다. 실시간 호가가 아니다.

> **저장소는 public이어야 한다.** 이 주기면 월 2,000분 안팎을 쓰는데, public 저장소는
> Actions가 무제한 무료이고 private은 무료 한도(월 2,000분)를 넘겨 과금된다.

## 데이터

| 파일 | 내용 |
|---|---|
| `public/data/market.json` | 지수 3종, 업종 79개 등락, 수집 시각, 종목 수 |
| `public/data/stocks.json` | 전 종목 약 4,300건 (주식·ETF·ETN) |

`stocks.json`은 크기를 줄이려고 객체 대신 `cols` 헤더 + 배열 행으로 싣는다.

```
cols: code, name, market, type, price, change, rate, volume, value, cap
      market 0=코스피 1=코스닥 · type 0=종목 1=ETF 2=ETN
      price·change 원 · rate % · volume 주 · value·cap 원
```

주의: 네이버 응답의 `marketValue`/`accumulatedTradingValue` 문자열은 각각 억원·백만원
단위지만 `*Raw` 필드는 원 단위다. `scripts/fetch.js`는 Raw를 우선 쓰고, 없을 때만 환산한다.

## 색

등락 표현은 발산형(diverging) 인코딩이다. 국내 관례대로 **상승=빨강 / 하락=파랑**,
보합은 중립 회색. 파랑 arm은 레퍼런스 blue 램프를 그대로 쓰고, 빨강 arm은 같은 명도
(OKLCH L 0.812 / 0.623 / 0.480)에 레퍼런스 red 색상을 얹어 계산했다 — 두 팔의 밝기가
대칭이라 부호만 다른 같은 크기가 같은 무게로 보인다.

색만으로 뜻이 전달되지 않도록 모든 등락 표기에 ▲▼ 글리프가 붙고, 히트맵에는 척도 범례와
동등한 **표 보기**가 함께 있다. 히트맵 셀 안 텍스트는 모든 구간에서 5:1 이상 대비를 낸다.

## 면책

네이버 금융의 공개 엔드포인트를 읽는다. 네이버와 무관하며 제휴 관계가 아니다.
수치는 지연·오류가 있을 수 있고, 정보 제공 목적이며 투자 권유가 아니다.
