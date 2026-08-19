// 문제 로딩 · setup 적용 · 채점.
//
// 채점은 상태 기반이다. 정답 명령어를 비교하지 않고, check 조건을 게스트에서
// 실행해 exit code 만 본다. 어떤 명령으로 풀었든 결과 상태가 맞으면 통과다.

import { writeFileCmd, FIND_SCRATCH } from "./vm.js";

export async function loadIndex() {
    const list = await (await fetch("problems/index.json")).json();
    const problems = [];
    for (const file of list) {
        const text = await (await fetch(`problems/${file}`)).text();
        problems.push({ file, ...jsyaml.load(text) });
    }
    return problems.sort((a, b) => (a.level - b.level) || a.id.localeCompare(b.id));
}

// 문제의 초기 상태를 만든다. 이전 문제의 흔적을 지우는 것부터 시작한다.
//
// setup 은 전부 채점 채널(root)에서 실행된다. 사용자 셸이 student 든 뭐든
// 상관없이 초기 상태를 만들 수 있고, 사용자 화면에도 안 보인다.
// 스크래치 디스크를 처음 상태로 되돌린다.
// 디스크는 /work 와 달리 문제를 바꿔도 남아 있으므로 명시적으로 지워야 한다.
// 파티션 테이블과 파일시스템 시그니처는 앞 1MB 안에 있어서 그만 지우면 충분하다.
//
// 커널의 디스크 이름 부여는 확정적이지 않다. sd 드라이버가 비동기로 probe 해서
// 부팅마다 64MB 스크래치가 sda 로, 루트가 sdb 로 뒤집힐 수 있다 (실측 10여 회 중 1~2회).
// 그래서 이름을 못 박지 않고 "루트가 아닌 디스크"를 찾아 쓴다.
//
// 안전장치: 그래도 루트와 같으면 중단한다. 여기서 틀리면 루트를 날린다.
const RESET_DISK = [
    `SCRATCH=$(${FIND_SCRATCH})`,
    'ROOTDISK=$(findmnt -no SOURCE / | sed "s/[0-9]*$//")',
    '[ -n "$SCRATCH" ] || exit 0',
    '[ "$SCRATCH" = "$ROOTDISK" ] && { echo "스크래치 디스크가 루트와 같다. 중단."; exit 9; }',
    '[ -b "$SCRATCH" ] || exit 0',
    // 이전 문제에서 마운트한 것을 전부 푼다
    'awk -v d="$SCRATCH" \'$1 ~ "^" d {print $2}\' /proc/mounts | while read m; do umount "$m" 2>/dev/null; done',
    'dd if=/dev/zero of="$SCRATCH" bs=1M count=1 2>/dev/null',
    // 커널이 들고 있던 옛 파티션 정보를 버리게 한다
    'blockdev --rereadpt "$SCRATCH" 2>/dev/null || true',
    // fstab 에 남은 항목도 정리한다 (영구 마운트 문제가 남긴다)
    'sed -i "\\|$SCRATCH|d" /etc/fstab 2>/dev/null || true',
].join("\n");

// 앞 문제가 디스크를 건드렸는지 기억한다.
// 매번 초기화하면 안전하지만 문제마다 왕복이 늘어 검증이 눈에 띄게 느려진다.
let diskDirty = false;

// 문제가 남긴 것들을 걷어낸다.
//
// 파일은 rm 으로 지우면 되지만 "돌고 있는 것"은 따로 정리해야 한다.
// 네트워크 문제가 띄운 가짜 서비스와 가상 IP, 프로세스 문제가 띄운 백그라운드 스크립트가
// 다음 문제까지 살아남으면 ps·netstat 결과가 오염된다.
const RESET_ENV = [
    "netlab reset 2>/dev/null || true",
    // /work 에서 실행된 것만 죽인다. 채점 채널이나 사용자 셸은 건드리지 않는다.
    "for pid in $(ps -o pid,args 2>/dev/null | awk '$2 ~ /^\\/work\\// {print $1}'); do kill -9 \"$pid\" 2>/dev/null; done",
    // sudo 권한을 문제마다 같은 상태로 되돌린다. 기본은 "권한 없음" 이다.
    //
    // /etc/sudoers 는 /work 밖이라 문제를 바꿔도 안 지워진다. 그래서 앞 문제에서
    // 받은 권한이 뒤 문제까지 따라다녔다 — 전부 root 로 돌 때는 티가 안 났지만
    // 계정을 student 로 바꾼 뒤로는 "앞에서 뭘 풀었느냐"가 권한을 바꾼다.
    //
    // 한때 NOPASSWD: ALL 을 기본으로 줬는데 그건 앞뒤가 안 맞았다.
    // su root 를 막아놓고 sudo 로 뭐든 되게 하면 잠근 의미가 없다 — 옆문이 열려 있다.
    // root 는 "관리자가 되는 것"이고 sudo 는 "일반 사용자가 이번 한 번만 빌리는 것"인데,
    // 무제한으로 열어두면 그 구분 자체가 사라진다.
    //
    // !authenticate 는 남겨둔다. student 에게는 비밀번호가 없어서, 이게 없으면
    // 권한이 없을 때 sudo 가 비번을 묻고 "Sorry, try again" 만 세 번 반복한다.
    // 이 줄이 있으면 "not allowed to execute" 라고 바로, 분명하게 거절한다.
    //
    // 권한이 필요한 문제는 자기 setup 에서 넣는다 (sudo-01 이 그렇게 한다).
    "sed -i '/student/d' /etc/sudoers 2>/dev/null || true",
    "echo 'Defaults:student !authenticate' >> /etc/sudoers",
    "true",
].join("; ");

export async function applySetup(vm, p) {
    const s = p.setup ?? {};
    // 기본은 일반 계정이다.
    //
    // 처음에는 root 를 기본으로 뒀는데 그건 배우는 환경으로서 틀렸다.
    // root 는 권한 검사를 통째로 우회해서, 파일 권한을 배우는 사람에게
    // "chmod 000 인데도 읽힌다" 같은 틀린 직관을 심는다.
    // 실제로 리눅스를 쓰는 사람이 앉는 자리도 일반 계정이고, 그래야 sudo 가
    // 왜 필요한지가 몸에 붙는다.
    //
    // 관리자 권한이 진짜로 필요한 문제(mount, mkfs, ip addr …)만 user: root 를 적는다.
    const user = s.user ?? "student";

    await vm.run(RESET_ENV, 30000);
    // 이 문제에서 sudo 를 허용하는가.
    //
    // 기본은 "안 됨" 이다. 관리자 작업을 내는 문제만 켠다 —
    // 그러면 sudo 가 필요한 순간이 문제 안에서 분명해지고,
    // 나머지 문제에서는 권한에 막히는 경험이 그대로 남는다.
    // 화면에도 표시한다 (main.js 의 renderProblem). 문제 본문에 손으로 적으면
    // 설정과 글이 언젠가 어긋난다 — 한 곳에서 나오게 한다.
    if (s.sudo) await vm.run("echo 'student ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers");
    await vm.run("rm -rf /work/* /work/.[!.]* 2>/dev/null; mkdir -p /work");
    // 디스크 문제를 막 끝냈거나 이제 시작하려는 경우에만 되돌린다.
    if (diskDirty || s.disks) {
        await vm.run(RESET_DISK, 60000);
        diskDirty = !!s.disks;
    }

    for (const [path, content] of Object.entries(s.files ?? {})) {
        const r = await vm.run(writeFileCmd(path, content));
        if (r.exit !== 0) throw new Error(`setup 파일 생성 실패: ${path}`);
    }
    if (s.script) {
        // set -e 를 붙인다. 안 붙이면 exit code 가 마지막 줄의 결과만 반영해서,
        // 중간이 실패해도 성공으로 보고된다. 그러면 문제가 절반만 차려진 채 열리고
        // 사용자는 시작부터 유지 조건이 깨진 화면을 본다 (file-06 에서 실제로 발생).
        //
        // 반드시 서브셸 ( ) 안에 가둔다. eval 로 실행되므로 괄호가 없으면 set -e 가
        // 채점 셸에 눌러붙고, 그 뒤로는 실패한 채점 조건 하나에 셸이 통째로 죽는다.
        // 채점 조건은 풀기 전에 실패하는 게 정상이라 사실상 매번 죽는다.
        const r = await vm.run(`(\nset -e\n${s.script}\n)`, 120000);
        if (r.exit !== 0) throw new Error(`setup 스크립트 실패 (exit ${r.exit}): ${r.out}`);
    }

    // 차려놓은 작업공간을 문제 계정 소유로 넘긴다.
    //
    // setup 은 채점 채널(root)에서 돌기 때문에 만들어진 파일이 전부 root 소유다.
    // 계정 기본값이 root 였을 때는 티가 안 났는데, student 로 바꾸니
    // mv·rm·chmod 가 "Permission denied" 로 줄줄이 막혔다 (51문제 중 5개).
    //
    // keepOwner 는 소유권 자체가 문제의 일부인 경우의 탈출구다 —
    // "root 가 가진 파일을 student 가 못 건드린다" 를 보여주는 문제까지 넘겨버리면
    // 문제가 성립하지 않는다.
    if (user !== "root" && !s.keepOwner) {
        await vm.run(`chown -R ${user} /work 2>/dev/null; true`, 30000);
    } else if (user !== "root") {
        const paths = Object.keys(s.files ?? {}).map((p) => `'${p}'`).join(" ");
        await vm.run(`chown ${user} /work ${paths} 2>/dev/null; true`);
    }

    // 계정 전환과 cd 로 생기는 찌꺼기(^C, exit, "can't access tty", cd 명령줄)는
    // 사용자가 볼 필요가 없다. 화면 갱신을 끊었다가 정리된 뒤에 다시 붙인다.
    //
    // 끊기만 하고 바로 풀면 안 된다. 셸이 뱉는 찌꺼기는 명령이 끝난 뒤에도
    // 조금 늦게 도착해서, 화면을 비운 직후에 그대로 찍힌다.
    // 출력이 잦아든 것을 확인하고 나서 풀어야 한다.
    vm.setMuted(true);
    try {
        // 앞 문제에서 vi 를 열어둔 채, 또는 sudo -s 로 중첩 셸에 들어간 채 넘어올 수 있다.
        // 그러면 아래의 ^C 와 cd 가 전부 그 프로그램의 입력으로 들어가서,
        // 화면에 vi 잔해가 남고 프롬프트가 영영 안 나온다.
        // 계정이 그대로면 switchUser 는 아무것도 안 하므로 여기서 따로 치워야 한다.
        await vm.cleanupForeground();
        // relogin 은 setup 이 그룹 소속을 바꿨을 때 쓴다.
        // 이미 떠 있는 셸은 새 그룹을 모르므로 셸을 새로 띄워야 반영된다.
        await vm.switchUser(user, { force: !!s.relogin });
        await vm.resetCwd(s.cwd ?? "/work");
        await vm.waitQuiet(300, 4000);
    } finally {
        vm.setMuted(false);
        // 프롬프트가 실제로 그려질 때까지 기다린 뒤 제어를 넘긴다
        await vm.clearScreen();
    }
}

// 사전·자유 터미널의 초기 상태.
//
// applySetup 과 같은 자리에 둔다. 하는 일이 거의 같은데 따로 쓰면 반드시 어긋난다 —
// 실제로 따로 만들었다가 화면 갱신을 끊는 부분을 빠뜨려서, 명령어를 넘길 때마다
// ^C 와 cd '/work' 가 터미널에 그대로 쌓였다.
//
// 문제와 다른 점은 두 가지뿐이다. 문제 파일 대신 연습용 파일을 깔고,
// 계정을 root 로 되돌린다 (권한 예시가 root 를 필요로 한다).
export async function applyPlayground(vm, seed) {
    await vm.run(RESET_ENV, 30000);
    const r = await vm.run(seed, 30000);

    vm.setMuted(true);
    try {
        await vm.cleanupForeground();
        await vm.switchUser("root");
        await vm.resetCwd("/work");
        await vm.waitQuiet(300, 4000);
    } finally {
        vm.setMuted(false);
        await vm.clearScreen();
    }
    return r;
}

// 조건은 두 종류다.
//
//   check — 목표. 풀기 전에는 반드시 실패해야 한다.
//   guard — 전제. 처음부터 참이고 끝까지 참이어야 한다.
//           "다른 파일은 건드리지 않았다" 같은 것.
//
// 둘을 섞으면 전제가 처음부터 통과로 표시돼서 진척도가 거짓말이 된다.
// (실제로 file-02 에서 "내용 있는 파일 2개는 그대로다" 가 시작하자마자 ✓ 였다.)
async function runAll(vm, list) {
    const out = [];
    for (const c of list ?? []) {
        const r = await vm.run(c.cmd, 30000);
        // noRun 은 "조건이 거짓"이 아니라 "조건을 실행조차 못 했다"는 뜻이다.
        // 둘을 뭉뚱그리면 게스트가 망가진 것을 못 푼 것으로 표시하게 된다 (vm.js runNow 참고).
        out.push({ desc: c.desc, ok: r.exit === 0, timedOut: !!r.timedOut, noRun: !!r.noRun });
    }
    return out;
}

export async function grade(vm, p) {
    return {
        goals: await runAll(vm, p.check),
        guards: await runAll(vm, p.guard),
    };
}

// 목표를 다 이뤘고 전제를 하나도 깨지 않았을 때만 통과다.
export const isSolved = (r) =>
    r.goals.length > 0 && r.goals.every((g) => g.ok) && r.guards.every((g) => g.ok);

export const brokeGuard = (r) => r.guards.some((g) => !g.ok);
