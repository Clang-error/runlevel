# 문제 만들기

YAML 파일 하나가 문제 하나다. 코드는 건드리지 않는다.

## 5분 안에 첫 문제 만들기

**1. 파일을 만든다**

```
problems/t1-text/text-07.yaml
```

폴더는 카테고리별로 아무거나 골라 넣으면 된다. 새 폴더를 만들어도 된다.
파일 이름은 `id` 와 같게 맞추는 게 나중에 찾기 편하다.

**2. 이 틀을 채운다**

```yaml
id: text-07                      # 파일명과 동일하게
category: 텍스트 처리             # 화면에 표시될 분류
level: 2                         # 1~5, 체감 난이도
prompt: |
  유저에게 보여줄 문제.
  무엇을 어디에 만들라고 구체적으로 쓴다.

setup:                           # 시작 상태
  cwd: /work
  files:
    /work/입력파일: |
      내용을 여기 적는다

check:                           # 목표. 하나씩 채점되고 한 줄씩 표시된다
  - desc: 결과 파일이 존재한다
    cmd: test -f /work/결과파일

hints:                           # 순서대로 하나씩 공개된다
  - 첫 힌트는 방향만 알려준다
  - 마지막 힌트는 거의 답이어도 된다

solution: 정답 명령어              # 필수. 이게 자동 테스트에 쓰인다
```

**3. 바로 검증한다**

```sh
cd spike
node lint-problems.mjs          # 즉시. 흔한 실수를 먼저 걸러낸다
node test-problems.mjs text-07  # 실제로 풀어본다 (몇 초)
```

린트는 VM 을 안 띄워서 즉시 끝난다. 이런 것들을 잡는다.

- id·파일명 불일치, 중복, level 범위, 빠진 항목
- **채점 조건이 상태를 바꾸는 경우** (다음 판정이 오염된다)
- **부정 조건인데 대상이 없을 때도 통과하는 경우** (공허한 참)
- `user: student` 인데 파일을 root 소유로만 만들어 손댈 수 없는 경우

통과하면 브라우저에서 새로고침만 하면 목록에 뜬다.

## solution 은 장식이 아니다

검증기가 문제마다 이걸 돌린다.

```
setup 적용 → 채점(전부 실패해야 함) → solution 실행 → 채점(전부 통과해야 함)
```

즉 `solution` 은 **테스트 픽스처**다. 비워두면 그 문제는 검증에서 건너뛰고,
나중에 조용히 망가져도 아무도 모른다. 반드시 채운다.

## 채점 조건 쓰는 법

`cmd` 는 게스트에서 실행되는 셸 명령이고, **exit code 0 이면 통과**다.
그래서 리눅스로 표현할 수 있는 건 전부 조건으로 쓸 수 있다.

자주 쓰는 것들:

```yaml
cmd: test -f /work/a.txt                          # 파일 존재
cmd: test -d /work/logs                           # 디렉터리 존재
cmd: test -s /work/a.txt                          # 존재 + 내용 있음
cmd: cmp -s /work/a.txt /work/b.txt               # 두 파일 같음
cmd: grep -q ERROR /work/a.txt                    # 문자열 포함
cmd: '[ "$(wc -l < /work/a.txt)" = 3 ]'           # 줄 수
cmd: '[ "$(stat -c %a /work/a.sh)" = 755 ]'       # 권한
cmd: '[ "$(stat -c %G /work/a.txt)" = team ]'     # 그룹
cmd: '[ "$(find /work -name "*.log" | wc -l)" = 2 ]'   # 개수
```

`$` 나 `"` 가 들어가면 YAML 에서 `'작은따옴표'` 로 감싼다.

`desc` 는 유저가 그대로 보는 문장이다. `"2줄이다"` 처럼 **뭘 확인하는지**를
쓰면 틀렸을 때 스스로 디버깅할 수 있다.

## 함정 두 가지만 조심하면 된다

둘 다 검증기가 잡아주지만, 알고 쓰면 처음부터 안 걸린다.

**① 부정 조건은 대상이 없으면 자동으로 참이 된다**

```yaml
cmd: '! grep -q TODO /work/out.txt'                        # 파일이 없으면 통과해버림
cmd: '[ -s /work/out.txt ] && ! grep -q TODO /work/out.txt'  # 존재부터 확인
```

**② 채점 조건은 상태를 바꾸면 안 된다**

```yaml
cmd: touch /work/probe && [ ... ]      # 남은 probe 가 다음 채점을 오염시킨다
```

읽기만 하는 명령을 쓴다 — `test` `stat` `grep -q` `wc` `cmp` `findmnt`.

## 목표(check) vs 전제(guard)

"이건 건드리지 마라" 같은 조건은 `check` 가 아니라 `guard` 다.

```yaml
check:                                   # 풀어야 달성되는 것
  - desc: logs 디렉터리가 있다
    cmd: test -d /work/logs
guard:                                   # 처음부터 참이고 깨지면 안 되는 것
  - desc: 다른 파일은 건드리지 않았다
    cmd: test -f /work/readme.txt
```

`guard` 를 `check` 에 넣으면 시작하자마자 ✓ 로 떠서 진척도가 거짓말이 된다.
검증기가 이걸 잡아서 "guard 로 옮길 것"이라고 알려준다.

## 계정 정하기

기본은 root 다. 권한 문제는 반드시 `user: student` 를 준다.
root 는 권한 검사를 우회해서 "실제로 막히는" 경험을 못 준다.

```yaml
setup:
  user: student
```

주의: `files:` 로 만든 파일만 student 소유가 된다.
`script:` 로 만든 것은 root 소유로 남으므로, student 가 고쳐야 하는 파일은
`files:` 로 만들어야 한다. (관리자 작업 문제는 그냥 root 로 두면 된다.)

## 복잡한 초기 상태가 필요하면

`files:` 로 안 되는 것(디렉터리 구조, 권한 비트, 일부러 망가뜨린 설정)은
`script:` 에 셸로 쓴다. root 로 실행된다.

```yaml
setup:
  script: |
    mkdir -p /work/project/src
    touch /work/project/a.conf /work/project/b.conf
    chmod 600 /work/project/a.conf
```

## 실행 불가한 명령어는 quiz 로

`ping`, `top`, `ssh` 처럼 브라우저에서 못 돌리는 건 출력만 보여주고 답을 묻는다.

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

## 범위를 지정하는 문제에는 미끼를 둬라

"/work/src 안에서 찾아라" 같은 문제에서, **src 밖에도 걸릴 만한 파일을 하나 둬야 한다.**
안 그러면 범위를 안 지킨 명령이 우연히 같은 답을 내고 통과한다.

실제로 grep-01 이 그랬다. `/work` 에 src 말고 아무것도 없어서
`grep -r TODO`(경로 생략)가 에러 메시지를 뱉으면서도 통과했다.

```yaml
setup:
  script: |
    printf '# TODO: 리팩터링\n' > /work/src/lib/util.py
    printf '# TODO: 이건 src 밖이다\n' > /work/notes.md   # ← 미끼
check:
  - desc: src 바깥의 notes.md 는 포함되지 않았다
    cmd: '[ -s /work/todo.txt ] && ! grep -q notes\.md /work/todo.txt'
```

미끼를 두면 범위 위반이 **줄 수**와 **미포함 조건** 양쪽에서 걸린다.

같은 이유로, 정답 하나만 통과시키려 하지 말고 **정당한 다른 풀이는 통과시켜야 한다.**
grep-01 은 `grep -r TODO /work/src`, `grep -r TODO src`,
`cd src && grep -r TODO .` 를 모두 받아들인다. 경로 표기 형식이 아니라
**결과의 범위**로 판정하기 때문이다.

## 좋은 문제의 기준

- **결과 상태로 채점된다** — 어떤 명령을 썼든 상관없어야 한다.
  `grep` 으로 풀든 `awk` 로 풀든 통과해야 진짜 실력 측정이다
- **조건이 쪼개져 있다** — "다 맞음/틀림" 하나보다 3개로 나뉜 게 훨씬 낫다.
  유저가 어디까지 왔는지 보인다
- **실수를 짚어준다** — 예를 들어 마운트 문제에서 fstab 조건을 따로 두면
  "마운트는 했는데 영구 설정을 빠뜨렸다"를 정확히 알려줄 수 있다
