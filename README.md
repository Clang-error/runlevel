# runlevel

브라우저에서 진짜 리눅스를 돌려 명령어와 서버 운영을 연습하는 학습 서비스.

목적은 두 가지다. (1) 내 리눅스 실력을 마운트/보안/서버관리 영역까지 끌어올린다.
(2) 결과물을 포트폴리오로 남긴다. 둘 중 하나만 원한다면 이 프로젝트는 안 하는 게 맞다.

## 스코프

| 티어 | 내용 | 상태 |
|---|---|---|
| T1 | 파일·텍스트·권한 (ls~awk, chmod/umask/SUID) | 이번에 만든다 |
| T2 | 마운트·디스크 (mount, lsblk, fdisk, mkfs, fstab) | 이번에 만든다 |
| T3 | 서비스·네트워크·보안 (systemctl, nginx, iptables, ssh) | 계획만, 코드 없음 |

**T2에서 제외**: LVM, RAID(mdadm), quota. 실력 올라가면 YAML 파일 추가로 붙인다.

**T3를 미루는 이유**: 서버 사이드 VM이 강제되고(→ 유저 수에 비례하는 비용),
브라우저로는 32비트 제약 때문에 최신 systemd 실습이 안 된다. 자세한 근거는
[docs/engine-research.md](docs/engine-research.md).

## 확정된 설계 결정

1. **실행 엔진은 v86.** BSD-2 라이선스, COOP/COEP 헤더 불필요(정적 호스팅만으로 배포 가능),
   진짜 리눅스 커널이라 보조 디스크를 붙이면 `fdisk`/`mkfs`/`mount`가 실제로 동작한다.
   서버 비용 0원으로 T2까지 커버되는 유일한 선택지.
2. **채점은 상태 기반.** 정답 명령어를 하드코딩하지 않는다.
   "어떤 명령을 썼는가"가 아니라 "시스템이 원하는 상태가 되었는가"만 본다.
3. **채점 조건은 셸 명령 + exit code.** 선언형 DSL(`file_exists:` 같은)을 쓰지 않는다.
   조건 하나 = 피드백 한 줄이 1:1로 붙어서 체크리스트 UI가 그대로 나온다.
   자세한 근거는 [docs/problem-schema.md](docs/problem-schema.md).
4. **문제는 YAML 데이터.** 코드 수정 없이 파일 추가만으로 문제가 늘어야 한다.
5. **엔진은 처음부터 무거운 걸 하나만.** T1을 가벼운 엔진으로 먼저 만들고 나중에
   교체하는 길은 재작업이 커서 택하지 않는다. 엔진은 v86 하나, 문제는 T1부터.

## 가상 네트워크 (netlab)

`ping`·`nmap`·`netstat` 을 **흉내가 아니라 진짜로** 연습시킨다.
바깥으로 나가는 길은 없지만 게스트 커널은 진짜라서, 루프백에 주소를 붙이면
그 사이의 ICMP·TCP 가 실제로 오간다.

```sh
netlab add 10.0.0.1 web01 22:SSH-2.0-OpenSSH_9.6 80
netlab add 10.0.0.2 db01 5432
netlab reset
```

- 주소는 **/32 로 붙인다.** /24 로 붙이면 서브넷 전체가 lo 로 향해서
  없는 주소까지 ping 에 응답한다 — "죽은 호스트" 시나리오가 성립하지 않는다
- 포트는 `nc -l` 로 실제로 연다. `netstat` 에 LISTEN 으로 잡히고 배너도 읽힌다
- `nmap` 은 기본 SYN 스캔이 raw 소켓을 요구해 막힌다. `-sT`(connect 스캔)를 쓴다
- `nmap` 은 자체 해석기를 써서 `/etc/hosts` 를 안 본다. DNS 가 없는 실습 환경 때문에
  생기는 인공적 차이라 `--system-dns` 를 붙이는 래퍼로 가려뒀다

## 안 하는 것

- T3 관련 코드 (계획 문서에만 존재)
- 실행 엔진 2종 유지
- 정답 명령어 문자열 비교 채점
- 치팅 방지 (클라이언트 실행이라 원천 불가. 학습용이므로 무시한다.
  실수로 정답이 노출되는 것만 막으면 충분)

## 문제 유형

| 유형 | 용도 | 채점 |
|---|---|---|
| `exec` | 실제로 시스템을 조작하는 문제 (전체의 ~70%) | 게스트에서 check 명령 실행 |
| `quiz` | 브라우저에서 실행 불가한 명령어 (`ping`, `top`, `ssh` 등) | 고정 출력 + 단답 |

## 다음 할 일

- [x] **스파이크 1** — 블록 디바이스. `hda`/`hdb`가 게스트에 진짜 ATA 디스크로 잡히고
      `fdisk` → `mount` → 읽기/쓰기 → `umount` → 재마운트까지 전부 동작 확인.
      **T2 계획 유효.**
- [x] **스파이크 2** — 채점 파이프라인. `serial0_send` + `serial0-output-byte`로
      exit code 회수 안정적. `check` 스키마를 설계대로 구현 가능.
- [x] **스파이크 3** — 학습용 이미지 빌드. Alpine 3.23.5 x86 + GNU 도구.
      **최초 로딩 34.6MB, 부팅 7초.** 완성된 이미지에서 text-03 문제의
      채점 조건 3개가 실제로 통과하는 것까지 확인.

- [x] **스파이크 4** — 브라우저 재현. 헤드리스 Chrome에서 **10/10 통과, 부팅 7.0초.**
      COOP/COEP 헤더 없는 평범한 정적 서버에서 그대로 동작.
      xterm.js 터미널로 직접 타이핑도 된다. (`web/`)

**스파이크 전부 통과. 엔진 리스크 해소.**

배포 크기: **37.3MB** (v86 엔진 2.3 + 커널 8.2 + initramfs 5.1 + rootfs(gzip) 9.7)
탭당 메모리: 약 **256MB** (게스트 RAM 128 + 루트 디스크 64 + 스크래치 64)
시작: **약 2초** (스냅샷 복원)

부팅을 하지 않고 **부팅이 끝난 상태를 복원**한다.
v86 은 순수 CPU 에뮬레이션이라 부팅 6초가 기기 성능에 그대로 비례하는데,
CPU 를 느리게 만들어 재보니 4배 느린 기기에서 45초까지 늘어났다.
스냅샷은 압축 해제와 메모리 복사뿐이라 기기 성능을 거의 타지 않는다.

| CPU | 부팅 방식 | 스냅샷 |
|---|---|---|
| 기준 | 7.0s | **1.8s** |
| 2배 느림 | 16.7s | **1.9s** |
| 4배 느림 | 44.8s | **2.2s** |
| 6배 느림 | 55.3s | **2.5s** |

대가는 다운로드 29 -> 37MB. 첫 방문에만 받고 이후는 캐시된다.
스냅샷에는 디스크 내용도 들어 있어서 커널·initramfs·디스크 이미지를 따로 받지 않는다.

`?boot=1` 을 붙이면 예전처럼 실제 부팅 과정을 볼 수 있다 (약 8초). 디버깅용이다.

전송량은 네 번에 걸쳐 줄였다. 153MB -> 47.6 -> 38.6 -> 27.1 -> 26.1MB.
- 디스크 이미지 gzip 선압축 + 브라우저에서 직접 해제 (호스트 압축 설정 불필요)
- initramfs 경량화 (14.1 -> 5.1MB)
- vim 제거와 **빈 공간 0 채우기** (`spike/slim-image.mjs`).
  파일을 지워도 내용은 디스크에 남아 gzip 이 그 쓰레기까지 압축한다. 0 으로 덮으면 확 줄어든다.

- 루트 디스크 128MB -> 64MB (`spike/resize-image.mjs`). 실사용이 33MB 라 나머지는 낭비였다.
  v86 은 디스크를 통째로 메모리에 들고 있어서 **탭당 64MB 를 아낀다.**

편집기는 `vi`(busybox)와 `nano`. vim 은 런타임까지 17MB 라 뺐다 —
busybox vi 도 모드 전환·hjkl·`:wq` 가 되는 진짜 vi 다.

**탭이 안 보이면 VM 을 멈춘다.** v86 은 순수 CPU 에뮬레이션이라, 열어둔 탭마다
게스트가 계속 돌면서 보고 있는 탭까지 느려진다.

`initramfs` 는 Alpine 기본값(14.1MB, 커널 모듈 357개)을 그대로 쓰면 안 된다.
부팅 때마다 전부 압축 해제하는 비용이 에뮬레이터에서 크다.
`spike/make-initramfs.mjs` 로 필요한 모듈만 남겨 5.1MB 로 줄인다 (부팅 7.5s → 6s).
**모듈은 이름으로 고르면 안 되고 `modules.dep` 의 의존성 폐포로 골라야 한다** —
`sd_mod` 가 숨겨 의존하는 `scsi_common` 이 빠져 루트를 못 찾은 적이 있다.

- [x] **문제 로더** — YAML → setup 적용 → 매 명령마다 자동 채점 → 체크리스트 표시.
      채점은 ttyS1(별도 시리얼)에서 돌아 사용자 화면에 안 보인다.
- [x] **문제 39개** — 텍스트 6, find 3, grep 3, 파이프라인 3, 권한 5, 파일 2, 디스크 3,
      sudo/SUID 4, 셸 스크립트 4, 네트워크 4, 프로세스 2
- [x] **목표(check) / 전제(guard) 분리** — 전제가 처음부터 ✓ 로 뜨던 문제 해결.
      검증기가 "setup 직후 통과하는 목표"를 실패로 잡아 강제한다
- [x] **배포 번들** (`npm run build`) — 정적 호스팅용 `dist/`.
      디스크 이미지를 gzip 으로 미리 압축해 **첫 방문 153MB → 37MB**

- [x] **`setup.user`** — 문제별로 사용자 셸 계정 지정 (root / student).
      권한 문제가 실제 의미를 갖는다.

- [x] **`setup.disks`** — T2 디스크 문제. 스크래치 디스크를 부팅 때 달아두고
      문제마다 초기화한다 (v86 은 핫플러그 불가). 빈 버퍼라 다운로드 0바이트.

- [x] **진도 저장** (localStorage) — 푼 문제 기록, 이어가기, 진도 초기화.
      서버도 계정도 없이 동작한다.

다음 (우선순위 순):
- [ ] 파일트리 패널 (변경분 하이라이트)
- [ ] 루트 권한 획득 문제 — sudo/SUID 설치 필요
- [ ] 계정 연동 / 서버 동기화 — 제일 마지막. 서버가 필요해지는 시점

결과 상세: [docs/spike-results.md](docs/spike-results.md)

v86은 브라우저 전용이 아니라 **Node에서도 돈다.** 시리얼로 게스트를 스크립트 조종할 수 있어서
스파이크를 전부 터미널에서 자동 검증했다. 이 하네스(`spike/harness.mjs`)는
나중에 채점기 회귀 테스트로 그대로 쓴다.
## 폴더 구조

```
docs/
  problem-schema.md     문제 YAML 스키마 정의
  engine-research.md    실행 엔진 조사 결과 (2026-08)
  spike-results.md      스파이크 결과 + 함정 + 재현 방법
problems/               문제 하나 = YAML 파일 하나. 여기에 추가하면 자동으로 잡힌다
  t1-text/              텍스트 처리 (cat, sort, grep, sed, awk)
  t1-file/              파일 조작 (mkdir, mv, find -delete)
  t1-find/              find (-name, -size, -exec)
  t1-grep/              grep (-r, -E, -v)
  t1-pipe/              파이프라인 (sort|uniq -c|head 조합)
  t1-perm/              권한 (chmod, chgrp, sticky, setgid)
  t1-sudo/              sudo·SUID (sudoers, -perm -4000, u-s)
  t1-script/            셸 스크립트 (인자, 조건문, 종료 코드)
  t1-net/               네트워크 (ip/ifconfig, ping, netstat, nmap)
  t1-proc/              프로세스 (ps, kill)
  t2-disk/              마운트·디스크 (fdisk, mkfs.ext4, mount, fstab)
spike/
  harness.mjs           Node에서 v86 부팅 + 시리얼 왕복 (채점기 원형)
  build-image.mjs       Alpine 이미지 빌드
  fix-image.mjs         전용 init 설치 + 검증
  shrink-image.mjs      512MB -> 128MB 축소
  add-packages.mjs      이미지에 패키지 추가 (라이브 ISO + apk --root)
  lint-problems.mjs     문제 파일 정적 검사 (VM 없이 즉시)
  make-initramfs.mjs    initramfs 경량화 (14.1MB -> 5.1MB)
  make-snapshot.mjs     부팅된 상태를 스냅샷으로 굳히기
  slim-image.mjs        디스크 이미지 다이어트 + 빈 공간 0 채우기
  resize-image.mjs      루트 디스크 크기 줄이기
  finalize-image.mjs    파일시스템을 깨끗한 상태로 (매 부팅 저널 복구 방지)
  diag-*.mjs            진단 스크립트
web/
  index.html            UI (문제 패널 + 터미널)
  main.js               부팅 · 화면 전환 · 자동 채점 배선 · 자체 검증
  vm.js                 v86 제어. ttyS0(사용자) / ttyS1(채점) 분리
  problems.js           문제 로딩 · setup 적용 · 채점
  progress.js           진도 저장 (localStorage)
  tree.js               파일트리 수집·비교·렌더
  serve.mjs             개발용 정적 서버
  verify.mjs            헤드리스 검증 러너
```

## 실행

```sh
cd web && npm install
npm start                       # http://localhost:8080
npm run build                   # 정적 배포용 dist/ 생성
npm run verify                  # 브라우저(헤드리스)에서 전체 회귀 테스트, 30초 안팎

cd spike
node lint-problems.mjs          # 문제 파일 정적 검사 (즉시)
node test-problems.mjs          # 브라우저 없이 문제만 빠르게 검증 (20초)
node test-problems.mjs text-04  # 문제 하나만
```

`?selftest=1` 을 붙이면 부팅 로그(BIOS~커널)를 보여주고 자체 검증을 돌린다.

문제를 새로 만들면 `test-problems.mjs` 로 먼저 돌려보는 게 빠르다.
브라우저 검증은 UI 배선까지 같이 보는 용도다.

`spike/images/`, `web/node_modules/` 는 gitignore. 이미지는 빌드 스크립트로 재생성한다.

## 문제 추가하기

`problems/<카테고리>/<id>.yaml` 에 파일 하나 만들면 끝. 코드는 안 건드린다.

```sh
cp docs/problem-template.yaml problems/t1-text/text-07.yaml
# 채운 뒤
cd spike && node test-problems.mjs text-07
```

자세한 방법과 함정은 [docs/making-problems.md](docs/making-problems.md).
