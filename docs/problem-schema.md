# 문제 스키마

문제 하나 = YAML 파일 하나. 코드 수정 없이 파일 추가만으로 문제가 늘어야 한다.

## 핵심 결정: 채점 조건은 선언형 DSL이 아니라 셸 명령이다

처음엔 이렇게 짜고 싶어진다.

```yaml
check:
  - file_exists: /work/error.txt
  - file_content: { path: /work/error.txt, equals: "..." }
```

이게 함정이다. 조건 타입을 하나씩 늘려가야 하는데 T2로 가는 순간
`mount_exists`, `fstype_is`, `fstab_has`, `perm_is`, `owner_is`... 끝이 없다.
결국 리눅스를 YAML로 재발명하게 된다.

대신 각 조건을 **게스트에서 실행하는 셸 명령 + exit code**로 두면 표현력이
리눅스 자체와 같아진다. 그리고 `desc`가 붙어 있으니 조건 하나 = 피드백 한 줄이
1:1로 대응해서 체크리스트 UI가 그대로 나온다.

반대로 `check`를 통짜 스크립트 하나로 두면 표현력은 같지만 "뭐가 틀렸는지"를
못 알려줘서 UI가 죽는다. **배열로 쪼개는 게 핵심.**

## 스키마

```yaml
id:        string    # 고유 ID (파일명과 일치)
type:      exec|quiz # 기본값 exec
category:  string
level:     1..5
prompt:    string    # 유저에게 보여줄 문제

setup:               # 초기 상태
  cwd:     string    # 시작 디렉터리
  user:    string    # 실행 사용자 (student | root)
  files:   map       # 경로 → 내용. 흔한 케이스를 짧게 쓰기 위한 선언형
  disks:   list      # T2 전용. 보조 디스크 부착
  script:  string    # 탈출구. 권한/소유자/망가진 설정 심기 등

check:               # 채점 조건. 배열 순서대로 표시된다
  - desc:  string    # 유저에게 보여줄 조건 설명
    cmd:   string    # 게스트에서 실행. exit 0 이면 통과

hints:     list      # 순서대로 하나씩 공개
solution:  string    # 모범 답안 (정답 판정에는 쓰지 않는다)
```

`setup`을 `files`와 `script` 하이브리드로 둔 이유: `files`가 90% 케이스를 짧게
처리하고, 권한 비트나 망가진 설정처럼 셸 한 줄이 YAML 열 줄보다 나은 경우를
`script`가 받는다. 되도록 `files`를 먼저 쓴다.

## 예시 1 — T1 (텍스트 처리)

```yaml
id: text-03
category: 텍스트 처리
level: 2
prompt: |
  /work/app.log 에서 ERROR가 포함된 줄만 골라
  /work/error.txt 로 저장하라.

setup:
  cwd: /work
  user: student
  files:
    /work/app.log: |
      INFO  start
      ERROR db timeout
      INFO  ok
      ERROR conn refused

check:
  - desc: error.txt 가 존재한다
    cmd: test -f /work/error.txt
  - desc: ERROR 줄만 들어있다
    cmd: '! grep -qv ERROR /work/error.txt'
  - desc: 2줄이다
    cmd: '[ "$(wc -l < /work/error.txt)" = 2 ]'

hints:
  - 특정 문자열이 든 줄만 뽑는 명령은 grep 이다.
  - 출력을 파일로 보내려면 리다이렉션 > 을 쓴다.
solution: grep ERROR /work/app.log > /work/error.txt
```

## 예시 2 — T2 (마운트)

```yaml
id: disk-02
category: 마운트
level: 4
prompt: |
  /dev/sdb 전체를 ext4로 포맷해 /data 에 마운트하고,
  재부팅 후에도 유지되게 하라.

setup:
  user: root
  disks:
    - dev: /dev/sdb
      size: 64M
  script: |
    mkdir -p /data

check:
  - desc: /data 가 마운트되어 있다
    cmd: mountpoint -q /data
  - desc: 파일시스템이 ext4 다
    cmd: '[ "$(findmnt -no FSTYPE /data)" = ext4 ]'
  - desc: fstab 에 등록되어 재부팅 후에도 유지된다
    cmd: grep -qE '\s/data\s' /etc/fstab

hints:
  - lsblk 로 디스크가 붙었는지 먼저 확인한다.
  - 마운트만 하면 재부팅 시 사라진다. /etc/fstab 을 봐라.
solution: |
  mkfs.ext4 /dev/sdb
  mount /dev/sdb /data
  echo '/dev/sdb /data ext4 defaults 0 2' >> /etc/fstab
```

세 번째 조건이 이 스키마의 진가다. "마운트했다"와 "영구 마운트했다"를 나눠서
채점하고, 유저는 `실패: fstab 에 등록되어...`를 보고 자기가 뭘 빠뜨렸는지 안다.
실무에서 제일 많이 하는 실수를 정확히 짚어주는 것이고, 선언형 DSL로는 못 만든다.

## 예시 3 — quiz 타입

브라우저에서 실행 불가한 명령어(`ping`, `top`, `ssh`, `wget`) 몫이다.
엔진 없이도 되므로 개발 초기에 콘텐츠를 채우기 좋고, 실제 시험/면접 문제 형태이기도 하다.

```yaml
id: proc-01
type: quiz
category: 프로세스
level: 2
prompt: 아래 ps 출력에서 좀비 프로세스의 PID는?
given: |
  UID   PID   PPID  STAT  COMMAND
  root  1201  1     S     /usr/sbin/nginx
  root  1330  1201  Z     [nginx] <defunct>
answer: "1330"
```

## 채점 채널은 사용자 터미널과 분리한다

v86은 `uart1: true` 로 두 번째 시리얼 포트를 준다. 이걸 채점 전용으로 쓴다.

| 포트 | 용도 | 계정 |
|---|---|---|
| ttyS0 | 사용자 터미널 (xterm 에 연결) | 문제가 지정 |
| ttyS1 | 채점 채널 | root 고정 |

채널이 나뉘면 **채점 명령이 사용자 화면에 절대 나타나지 않고**, 사용자가 명령을
치는 도중에 채점해도 서로 간섭하지 않는다. 한 채널로 처리하려고 하면
"채점 중에는 입력을 막는다" 같은 군더더기가 필요해진다.

init 이 부팅 때 두 셸을 다 띄운다.

```sh
setsid sh -c 'while :; do /bin/sh < /dev/ttyS1 > /dev/ttyS1 2>&1; done' &   # 채점
while :; do /bin/bash; done                                                # 사용자
```

**init 이 `exec /bin/sh` 를 하면 안 된다.** 셸이 PID 1 이 되어 사용자가 `exit` 를
치는 순간 `Attempted to kill init` 커널 패닉이 난다. 자식으로 돌리고 죽으면 다시 띄운다.

## v86에서 check를 실행하는 방법

v86은 게스트 시리얼 콘솔에 명령을 밀어넣고 출력을 회수할 수 있다.
조건 하나당 이렇게 왕복한다.

```js
emulator.serial0_send(`${cmd}; echo __CHK__$?\n`)
// serial0-output-byte 리스너로 출력을 모으다가 __CHK__N 을 파싱
```

파일 내용 검증만 필요한 T1 문제는 9p 경로(`emulator.read_file(path)`)가 더 빠르다.
두 경로를 다 쓰되, `check.cmd` 계약은 동일하게 유지한다.
T3를 나중에 서버로 옮겨도 "체크 스크립트 → exit code" 계약이 그대로라 문제 파일은 안 바뀐다.

## check 와 guard — 목표와 전제를 구분한다

```yaml
check:                    # 목표. 풀기 전에는 반드시 실패해야 한다
  - desc: logs 디렉터리가 있다
    cmd: test -d /work/logs
guard:                    # 전제. 처음부터 참이고 끝까지 참이어야 한다
  - desc: 다른 파일은 건드리지 않았다
    cmd: test -f /work/readme.txt && test -f /work/data.csv
```

둘을 `check` 에 섞으면 전제가 시작부터 통과로 표시돼 진척도가 거짓말이 된다.
UI 도 다르게 보여준다 — 목표는 `·` 에서 `✓` 로 채워지고,
전제는 조용히 있다가 깨졌을 때만 빨간 `✗` 가 된다.

**검증기가 이 구분을 강제한다.** `check` 중 하나라도 setup 직후에 통과하면 실패로 잡는다.
guard 로 옮기거나 조건을 고치라는 뜻이다.

## 흔한 함정 두 가지

둘 다 실제로 겪었고, 검증기가 잡아준 것들이다.

**① 공허한 참** — 부정 조건은 대상이 없으면 자동으로 참이 된다.

```yaml
cmd: '! grep -qv ERROR /work/error.txt'              # 파일이 없으면 통과해버린다
cmd: '[ -s /work/error.txt ] && ! grep -qv ERROR /work/error.txt'   # 존재부터 확인
```

`! grep`, `! test`, `find ... | wc -l = 0` 같은 조건을 쓸 때는
**대상이 존재하는지 먼저 확인**해야 한다.

**② 부작용 있는 채점** — `cmd` 가 상태를 바꾸면 다음 판정이 오염된다.

```yaml
cmd: touch /work/upload/.probe && [ "$(stat -c %G /work/upload/.probe)" = www ]
```

첫 채점에서 만든 `.probe` 가 남아, 나중에 정답을 맞혀도 옛 그룹 그대로라 계속 실패한다.
setgid 는 `stat -c %a` 로 확인하면 충분했다.
**읽기 전용 명령만 쓴다** — `test`, `stat`, `grep -q`, `findmnt`, `mountpoint`, `wc`.

## 규칙

- **`check.cmd`는 절대 상태를 바꾸지 않는다.** 채점이 파일을 건드리면 다음 조건 판정이
  오염된다. `test` / `grep -q` / `findmnt` / `mountpoint` 계열만 쓴다.
- **채점 명령은 터미널에 표시하지 않는다.** 안 그러면 정답이 그대로 노출된다.
  (작정하면 어차피 볼 수 있지만, 실수로 보이는 것만 막으면 충분하다.)
- **채점 타이밍은 매 명령 실행 직후 자동.** 제출 버튼을 두지 않는다.
  한 줄로 푸는 사람과 여러 명령으로 나눠 푸는 사람이 둘 다 자연스럽게 커버된다.
  구현은 "엔터를 누른 뒤 출력이 400ms 잦아들면 채점"이다.

## 채점 명령은 base64 로 감싸 보낸다

여러 줄짜리 `setup.script` 나 `solution` 을 그대로 시리얼에 흘려보내면 깨진다.

```
/work # printf '#!/bin/bash\n...' > deploy.sh
/work # chmod 644 deploy.sh
/work # ; echo "__CHK__$?"          <- 마지막 줄에 홀로 남아 syntax error
```

마커가 딴 줄로 밀려나 **영영 응답이 없고 타임아웃까지 대기**한다.
문제 5개가 이러면 5분이 그냥 날아간다 (실제로 겪었다).

그래서 명령을 항상 한 줄로 만든다.

```js
sendGrade(`echo "__RUN""__"; eval "$(printf %s '${b64(cmd)}' | base64 -d)"; echo "__CHK""__$?"\n`)
```

따옴표·줄바꿈·특수문자를 전부 신경 안 써도 되는 부수 효과도 있다.

## 문제를 추가하면 자동으로 검증된다

`npm run verify` 는 모든 문제에 대해 이 순서를 돌린다.

1. `setup` 적용
2. 채점 → **실패해야 한다.** setup 직후에 이미 통과하면 문제 정의 오류다
3. `solution` 을 사용자 채널에 실제로 타이핑
4. 채점 → **전부 통과해야 한다**

즉 `solution` 은 장식이 아니라 테스트 픽스처다. 문제를 새로 만들 때
`solution` 을 반드시 채워야 하는 이유고, 채점기와 문제 세트가 함께 검증된다.

## setup.user — 문제 계정

**기본값은 `student` 다.** 관리자 권한이 진짜로 필요한 문제만 `user: root` 를 적고,
왜 필요한지 주석을 남긴다.

처음에는 root 가 기본값이었는데 그건 틀린 선택이었다. root 는 권한 검사를 통째로
우회해서 `chmod 000` 을 걸어도 읽히고, sudo 문제를 root 로 푸는 앞뒤 안 맞는 일이
생긴다. 지금 root 가 필요한 것은 다섯 개뿐이다 — `disk-01/02/03`(mount·mkfs),
`perm-05`(자기가 속하지 않은 그룹으로 chgrp), `proc-02`(root 프로세스 종료),
그리고 `sudo-02/04`(sudoers 편집, 남의 파일 SUID 제거).

동작 방식은 단순하다. init 이 매 바퀴 `/etc/runlevel/user` 를 다시 읽으므로,
채점 채널이 그 파일을 고치고 사용자 셸에 `exit` 를 보내면 다음 바퀴에서
새 계정으로 뜬다. 계정 전환 도구가 따로 필요 없다.

**setup 이 만든 것은 `/work` 째로 문제 계정 소유가 된다.**
setup 은 채점 채널(root)에서 돌기 때문에 그대로 두면 전부 root 소유라
`mv`·`rm`·`chmod` 가 막힌다.

소유권이나 특수 비트 자체가 문제의 일부라면 `keepOwner: true` 로 빠져나간다.

```yaml
setup:
  keepOwner: true    # chown 이 SUID 를 지운다 (POSIX). sudo-03 이 이것 때문에 깨졌다
```

`chown` 은 SUID·SGID 를 지운다. 특수 비트를 세팅하는 문제는 반드시 `keepOwner` 를 준다.

`setup` 자체는 항상 채점 채널(root)에서 실행되므로,
문제 계정이 무엇이든 초기 상태를 만드는 데는 제약이 없다.

## 계정과 비밀번호

| 계정 | 비밀번호 | 용도 |
|---|---|---|
| root | **잠김(`!`)** | 채점 채널, 관리자 문제 |
| student | 미설정(잠김) | 일반 문제. `sudo` 는 비번 없이 된다 |

**root 는 잠가야 한다.** 알파인 기본 이미지는 root 비밀번호가 비어 있어서
`su root` 한 줄이면 아무것도 안 묻고 관리자가 됐고, 그러면 문제를 일반 계정으로
돌리는 의미가 통째로 사라진다. `dotslash-init` 이 매 부팅마다 `root::` 를 `root:!:` 로 바꾼다.

잠가도 아무것도 안 깨진다 — init 과 채점 채널은 이미 root 로 떠 있고,
root 가 `su` 로 남의 계정이 되는 것은 비밀번호를 묻지 않는다.
권한이 필요하면 `sudo` 로 올라간다. 요즘 배포판이 실제로 그렇게 구성돼 있다.

`sudo` 권한은 `RESET_ENV` 가 문제마다 다시 세운다 (`NOPASSWD: ALL`).
`/etc/sudoers` 는 `/work` 밖이라 놔두면 앞 문제에서 받은 권한이 계속 따라다닌다.
권한이 없는 상태가 필요한 문제는 자기 `setup` 에서 그 줄을 지운다 (`sudo-02`).
나중에 "루트 권한 따기" 문제를 만들 때는 문제별 `setup.script` 에서
원하는 비밀번호나 SUID 바이너리를 심으면 된다. 이미지에 고정 비밀번호를
박아두는 것보다 문제마다 다른 시나리오를 만들 수 있어 낫다.

## setup.sudo — 이 문제에서 sudo 를 허용할지

**기본은 "안 됨" 이다.** `sudo` 를 치면 `student is not allowed to execute ...` 로 거절당한다.

```yaml
setup:
  sudo: true
```

관리자 작업을 내는 문제만 켠다. 그러면 sudo 가 필요한 순간이 문제 안에서 분명해지고,
나머지 문제에서는 권한에 막히는 경험이 그대로 남는다.

한때 모든 문제에 `NOPASSWD: ALL` 을 기본으로 줬는데 그건 앞뒤가 안 맞았다.
`su root` 를 막아놓고 `sudo` 로 뭐든 되게 하면 잠근 의미가 없다 — 옆문이 열려 있다.
**root 는 "관리자가 되는 것"이고 sudo 는 "일반 사용자가 이번 한 번만 빌리는 것"인데**,
무제한으로 열어두면 그 구분 자체가 사라진다.

`user: root` 와 `sudo: true` 중 무엇을 쓸지는 이렇게 가른다.

| 상황 | 선택 |
|---|---|
| 관리자가 하는 일이지만 명령 몇 개면 되는 것 (`mount`, `mkfs`, `chgrp`, `kill`) | `sudo: true` |
| sudo 권한 자체를 다루는 문제 (닭과 달걀) | `user: root` |
| 정답에 `>> /etc/파일` 같은 리다이렉션이 있는 것 | `user: root` |

마지막 줄이 중요하다. **리다이렉션은 sudo 이전에 사용자 셸이 처리하므로
`sudo echo ... >> /etc/fstab` 은 막힌다.** `echo ... | sudo tee -a` 로 풀어야 하는데,
그건 그것대로 가르칠 값어치가 있지만 다른 것을 가르치려던 문제의 초점을 흐린다.
(`disk-02` 가 그래서 root 로 남아 있다.)

화면에는 `sudo 사용 가능` / `관리자(root)로 시작` 배지가 자동으로 뜬다.
**문제 본문에 손으로 적지 마라** — 설정과 글이 언젠가 어긋난다.

## setup.keepOwner — 소유권을 그대로 두기

`applySetup` 은 setup 이 만든 것을 `/work` 째로 문제 계정에 넘긴다.
소유권이나 특수 비트가 문제의 일부라면 이 플래그로 빠져나간다.

```yaml
setup:
  keepOwner: true
```

**`chown` 은 SUID·SGID 를 지운다 (POSIX).** `chmod 4755` 로 SUID 를 붙여놓고
`keepOwner` 를 안 주면, 문제를 열자마자 "SUID 가 없음" 목표가 이미 통과한 상태가 된다.
`sudo-03` 과 `sudo-04` 가 실제로 그렇게 깨졌다 — 두 번 다 전 문제를 돌리고 나서야 알았다.
지금은 `lint-problems.mjs` 가 즉시 잡는다.

## setup.relogin — 셸을 새로 띄우기

```yaml
setup:
  relogin: true
```

**그룹 소속은 로그인할 때 정해진다.** setup 이 `adduser student team` 으로 그룹에 넣어도
이미 떠 있는 셸은 그걸 모른다 — 실제 리눅스에서 그룹을 바꾼 뒤 다시 로그인해야
반영되는 것과 같은 이유다.

`perm-03` 이 이것 때문에 **브라우저에서만** 실패했다. `test-problems.mjs` 는 정답을
매번 `su` 로 새로 띄워 실행하므로 이 차이가 드러나지 않는다. 두 검증의 사각지대였다.

## setup.disks — 디스크 문제

```yaml
setup:
  disks:
    - dev: /dev/sdb
      size: 64M
```

**v86 은 디스크 핫플러그가 안 된다.** 부팅 뒤에 디스크를 붙일 수 없어서,
스크래치 디스크 하나를 처음부터 달아두고 문제마다 초기화하는 방식으로 동작한다.
빈 버퍼로 만들기 때문에 다운로드는 0바이트다.

그래서 `dev` 와 `size` 는 **선언이 아니라 문서**에 가깝다.
실제로는 늘 `/dev/sdb` 64MB 하나다. 크기를 바꾸려면 `web/vm.js` 의 `SCRATCH_MB` 와
`spike/test-problems.mjs` 의 값을 같이 고쳐야 한다.

초기화는 **모든 문제 전환마다** 돈다. 디스크를 안 쓰는 문제에서도 되돌린다.
앞 문제가 남긴 마운트나 fstab 항목이 뒤 문제를 오염시키는 편이 더 나쁘기 때문이다.

```sh
# 이전 마운트 해제 -> 파티션 테이블/시그니처 제거 -> 커널에 알림 -> fstab 정리
umount ... ; dd if=/dev/zero of=/dev/sdb bs=1M count=1 ; blockdev --rereadpt /dev/sdb
sed -i '\|/dev/sdb|d' /etc/fstab
```

앞 1MB 만 지우면 파티션 테이블과 파일시스템 슈퍼블록이 같이 날아가서 충분하다.

## 비ASCII 는 반드시 base64 로 감싼다

`serial0_send()` 는 문자열을 그대로 넘겨 **한글 같은 멀티바이트 문자를 깨뜨린다.**
깨진 바이트가 따옴표를 어긋나게 하면 셸이 연속 입력(`>`) 상태에 갇히고,
그 뒤 모든 명령이 타임아웃난다. 시스템이 망가진 것처럼 보이지만 셸이 갇힌 것뿐이다.

두 겹으로 막는다.

1. 전송은 `serial_send_bytes(n, TextEncoder().encode(s))` 로 UTF-8 바이트를 보낸다
2. 채점 명령은 항상 base64 로 감싼다 (내용이 뭐든 ASCII 한 줄이 된다)
3. 그래도 타임아웃이 나면 `\x03` 을 보내 셸을 끊어준다

## 아직 구현 안 된 것

- 디스크 2개 이상을 요구하는 문제 (RAID 등). 스크래치 디스크가 하나뿐이다.
