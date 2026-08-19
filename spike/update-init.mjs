// init 을 교체한다. 채점 전용 셸을 ttyS1 에 띄우는 게 핵심.
//
// ttyS0 = 사용자 터미널, ttyS1 = 채점 채널.
// 채널이 분리되면 채점 명령이 사용자 화면에 절대 섞이지 않고,
// 사용자가 명령을 치는 중에 채점해도 서로 간섭하지 않는다.
//
// 채점 셸은 root 로 돈다. 사용자 셸은 문제에 따라 다른 계정일 수 있다
// (권한 문제를 내려면 root 가 아니어야 한다).
//
// init 은 절대 exec 로 셸이 되면 안 된다. 그러면 셸이 PID 1 이 되어
// 사용자가 exit 를 치는 순간 "Attempted to kill init" 커널 패닉이 난다.
// 셸을 자식으로 돌리고 죽으면 다시 띄운다.

import fs from "node:fs";
import { boot, img, report, writeFile } from "./harness.mjs";

const INIT = `#!/bin/sh
mount -t proc     proc /proc      2>/dev/null
mount -t sysfs    sys  /sys       2>/dev/null
mount -t devtmpfs dev  /dev       2>/dev/null
mount -o remount,rw /
mkdir -p /dev/pts && mount -t devpts devpts /dev/pts 2>/dev/null
mount -t tmpfs tmpfs /tmp 2>/dev/null
hostname runlevel

# devtmpfs 는 장치 노드만 만들고 표준 심볼릭 링크는 안 만든다.
# 보통은 배포판 init(OpenRC 등)이 붙여주는데 우리는 그걸 안 쓴다.
#
# /dev/fd 가 없으면 프로세스 치환 <( ) 이 "cat: /dev/fd/63: No such file"로 죽는다.
# 셸이 못 하는 게 아니라 셸이 열어준 fd 를 가리킬 경로가 없어서다.
# 붙여주면 bash 는 물론 busybox sh 에서도 된다 (실측).
ln -sf /proc/self/fd   /dev/fd
ln -sf /proc/self/fd/0 /dev/stdin
ln -sf /proc/self/fd/1 /dev/stdout
ln -sf /proc/self/fd/2 /dev/stderr

# 루프백을 올린다. 이게 DOWN 이면 ping/nmap 이 "route 를 못 찾는다"며 실패한다.
# 가상 네트워크 실습(netlab)이 전부 여기 얹힌다.
ip link set lo up 2>/dev/null

# 일반 계정도 ping 을 쓸 수 있게 한다.
#
# ping 은 원래 raw 소켓이 필요해서 setuid 나 CAP_NET_RAW 를 달고 다녔는데,
# 요즘 리눅스는 이 범위 안의 그룹에 ICMP 소켓을 열어준다. 배포판들이 그렇게 넘어갔다.
# 안 열어두면 문제 계정을 student 로 돌린 순간 net-02(살아있는 서버 찾기)가 죽는다.
# ping 에 root 가 필요하다는 건 이제 사실이 아니라, 그걸 이유로 root 를 쓰게 하면 안 된다.
sysctl -w net.ipv4.ping_group_range="0 2147483647" >/dev/null 2>&1 || \
    echo "0 2147483647" > /proc/sys/net/ipv4/ping_group_range 2>/dev/null

# nmap 은 resolv.conf 가 없으면 이름을 못 풀고 경고를 뱉는다.
# 비어 있어도 되고, 그러면 /etc/hosts 를 쓰는 시스템 해석기로 넘어간다.
[ -f /etc/resolv.conf ] || : > /etc/resolv.conf

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export TERM=linux

# 히스토리를 디스크에 남기지 않는다.
#
# 이 줄은 반드시 채점 채널을 띄우기 전에 와야 한다. 아래에 뒀더니 채점 셸이
# 물려받지 못해서 /.ash_history 가 계속 다시 생겼다.
# 그게 단순한 잔재가 아니다 — 채점 채널이 실행하는 것이 곧 정답 조건이라,
# 사용자가 cat /.ash_history 로 무엇을 검사하는지 그대로 읽을 수 있었다.
#
# 빈 값으로는 안 멈춘다. busybox ash 는 HISTFILE 이 비어 있으면
# $HOME/.ash_history 로 되돌아가고, 이 셸은 HOME 이 없어서 / 에 쌓는다.
# /dev/null 로 보내면 파일이 생기지 않는다. 화살표로 불러오는 것은 그대로 된다.
export HISTFILE=/dev/null

# 채점 채널 (root 고정). 죽으면 다시 띄운다.
if [ -c /dev/ttyS1 ]; then
    # stdin 을 /dev/null 로 떼어놓는다. 이 래퍼의 stdin 이 콘솔(ttyS0)로 남아 있으면
    # "ttyS0 을 쓰는 프로세스 정리"에 같이 휩쓸려 죽어서 채점 채널이 되살아나지 못한다.
    setsid sh -c 'while :; do /bin/sh < /dev/ttyS1 > /dev/ttyS1 2>&1; done' < /dev/null &
fi

# root 로 갈아타는 문을 잠근다.
#
# 알파인 기본 이미지의 root 는 비밀번호가 비어 있다. 그러면 student 가 su root 한 줄로
# 관리자가 되고, 문제를 일반 계정으로 돌리는 의미가 통째로 사라진다.
# (실제로 그랬다 — su root 를 치면 아무것도 안 묻고 바로 넘어갔다.)
#
# 잠가도 이 환경은 멀쩡히 돈다. init 과 채점 채널은 이미 root 로 떠 있고,
# root 가 su 로 남의 계정이 되는 것은 비밀번호를 안 묻는다.
# 권한이 필요하면 sudo 로 올라간다 — 실제 리눅스에서 하는 방식과 같다.
sed -i 's|^root::|root:!:|' /etc/shadow 2>/dev/null || true

# 문제 풀이용 사용자. 권한 문제를 내려면 root 가 아니어야 한다.
#
# 로그인 셸은 bash 다 (아래 사용자 셸 주석 참고). root 와 갈리면 안 된다 —
# 계정을 바꿨을 뿐인데 배열이 되다 안 되다 하면 그게 더 헷갈린다.
id student >/dev/null 2>&1 || adduser -D -s /bin/bash student 2>/dev/null
# 이미 만들어진 계정도 맞춰둔다 (이미지를 다시 안 만들어도 되게)
sed -i 's|^student:\\(.*\\):/bin/sh$|student:\\1:/bin/bash|' /etc/passwd 2>/dev/null
mkdir -p /work /etc/runlevel
[ -f /etc/runlevel/user ] || echo root > /etc/runlevel/user

# bash 의 기본 프롬프트는 "bash-5.3$" 다. 그대로 두면 풀이 기록 추출과
# 화면 정리가 프롬프트 모양을 못 알아본다 (web/vm.js, recordTyped 참고).
#
# \\$ 는 root 면 # 를, 아니면 $ 를 찍는다. 그래서 한 줄로 두 계정을 다 맞출 수 있다.
# 홈 디렉터리의 .bashrc 가 아니라 환경변수로 넘긴다 — su 가 환경을 물려주므로
# 계정이 바뀌어도 따라가고, 홈이 없는 계정에서도 성립한다.
# (.bashrc 로 했더니 student 홈이 없어서 그 계정만 프롬프트가 달랐다.)
export PS1='\\w \\$ '

# $SHELL 은 "지금 도는 셸"이 아니라 "이 계정의 로그인 셸"이다.
# 안 채워두면 vi 의 :sh, less 의 ! 같은 것이 엉뚱한 셸을 띄우고,
# echo $SHELL 로 확인한 사람에게도 거짓말을 한다.
export SHELL=/bin/bash

# 앞에 공백을 붙여 보낸 명령은 히스토리에 안 남긴다.
#
# 사용자 셸에는 사람만 치는 게 아니다. 준비 확인(__BOOT_OK__), 작업 위치 복귀(cd),
# 계정 전환(exit) 을 앱이 같은 줄로 보내고, 스냅샷을 만들 때도 이 셸을 쓴다.
# 그게 그대로 쌓여서 history 를 치면 __RUN__ 표식과 base64 덩어리가 쏟아졌다.
# 보내는 쪽이 공백 하나만 앞에 붙이면 사람이 친 것만 남는다.
export HISTCONTROL=ignorespace

# readline 의 bracketed paste 를 끈다.
# 켜져 있으면 프롬프트마다 \\033[?2004h 가 터미널로 흘러나온다. 사람 눈에는 안 보이지만
# 화면을 글자로 읽어 검사하는 쪽(풀이 기록, 자체 검증)에는 그대로 잡음이 된다.
# /etc/inputrc 는 --norc 와 무관하게 읽히므로 여기에 둔다.
# Alpine 이 이미 하나 깔아두므로 "없으면 만든다"로는 안 된다. 덮어쓴다.
printf 'set enable-bracketed-paste off\\n' > /etc/inputrc

# 사용자 셸 (ttyS0).
# exec 를 쓰면 셸이 PID 1 이 되어 exit 시 커널 패닉이 난다. 자식으로 돌린다.
#
# 어떤 계정으로 띄울지는 /etc/runlevel/user 를 매번 다시 읽는다.
# 문제를 바꿀 때 채점 채널이 이 파일을 고치고 사용자 셸에 exit 를 보내면
# 다음 바퀴에서 새 계정으로 뜬다. 별도 도구 없이 계정 전환이 된다.
while :; do
    u=$(cat /etc/runlevel/user 2>/dev/null)
    [ -n "$u" ] || u=root
    id "$u" >/dev/null 2>&1 || u=root
    # 작업 디렉터리는 현재 계정이 쓸 수 있어야 한다
    chown "$u" /work 2>/dev/null
    # 현재 계정을 남긴다. 채점 채널이 이 파일만 읽으면 되므로
    # 계정이 바뀌었는지 확인하려고 사용자 터미널을 건드릴 필요가 없다.
    echo "$u" > /etc/runlevel/current
    cd /work 2>/dev/null || cd /
    # setsid --ctty 로 제어 터미널을 붙인다.
    #
    # 이게 없으면 job control 이 꺼져서 커널이 ^C 를 전면 프로세스에 전달하지 못한다.
    # ping 을 실행하면 멈출 방법이 없어진다 (문제를 바꿔도 계속 돈다).
    #
    # 리다이렉션을 명시해야 한다. 안 하면 첫 세션이 터미널을 가져간 뒤
    # 다시 뜬 셸이 입출력에 붙지 못해 exit 후 복구가 안 된다.
    #
    # 사람이 치는 셸은 bash 다. 배우는 사람이 보는 자료가 거의 bash 기준이고,
    # 실제 서버에서도 로그인해서 쓰는 셸은 대개 bash 다.
    # (스크립트의 /bin/sh 가 dash·ash 인 것과는 다른 이야기다.)
    #
    # 채점 채널(ttyS1)은 /bin/sh 그대로 둔다. 문제의 check·solution 은 POSIX 로 짜여
    # 있고 test-problems.mjs 도 그 셸에서 돈다. 여기까지 바꿀 이유가 없다.
    #
    # --norc 로 띄운다. 프롬프트는 위에서 내보낸 PS1 이 정하고, 그 외의 설정 파일이
    # 끼어들면 프롬프트 모양이 언제든 바뀔 수 있다. 그게 바뀌면 화면을 읽는 쪽이 깨진다.
    if [ "$u" = root ]; then
        setsid --ctty -w env HOME=/root /bin/bash --norc < /dev/ttyS0 > /dev/ttyS0 2>&1
    else
        setsid --ctty -w su -s /bin/bash "$u" -- --norc < /dev/ttyS0 > /dev/ttyS0 2>&1
    fi
done
`;
// 가상 네트워크 실습 헬퍼.
//
// 바깥으로 나가는 길은 없지만 커널은 진짜다. 루프백에 /32 주소를 붙이면
// 그 사이의 ICMP·TCP 가 실제로 오간다. 그래서 ping·nmap·netstat 를
// 흉내가 아니라 진짜로 연습시킬 수 있다.
//
//   netlab add 10.0.0.1 web01 22:SSH-2.0-OpenSSH_9.6 80
//   netlab reset
//
// /24 가 아니라 /32 를 쓰는 게 중요하다. /24 로 붙이면 서브넷 전체가 lo 로 향해서
// 없는 주소(10.0.0.99)까지 ping 에 응답해버린다. 그러면 "죽은 호스트" 시나리오를 못 만든다.
const NETLAB = `#!/bin/sh
case "$1" in
add)
    ip="$2"; name="$3"; shift 3
    ip addr add "$ip/32" dev lo 2>/dev/null
    grep -q "[[:space:]]$name\\$" /etc/hosts || echo "$ip $name # netlab" >> /etc/hosts
    for spec in "$@"; do
        port=\${spec%%:*}
        banner=\${spec#*:}
        [ "$banner" = "$spec" ] && banner=""
        (
            while :; do
                if [ -n "$banner" ]; then
                    printf '%s\\r\\n' "$banner" | nc -l -p "$port" -s "$ip" >/dev/null 2>&1
                else
                    nc -l -p "$port" -s "$ip" >/dev/null 2>&1
                fi
                sleep 0.1 2>/dev/null || true
            done
        ) >/dev/null 2>&1 &
    done
    ;;
reset)
    # 띄워둔 가짜 서비스와 주소를 걷어낸다
    for pid in $(ps -o pid,args 2>/dev/null | awk '/nc -l -p/ && !/awk/ {print $1}'); do
        kill -9 "$pid" 2>/dev/null
    done
    for a in $(ip -4 -o addr show lo 2>/dev/null | awk '{print $4}' | grep -v '^127\\.'); do
        ip addr del "$a" dev lo 2>/dev/null
    done
    sed -i '/# netlab$/d' /etc/hosts 2>/dev/null
    ;;
*)
    echo "사용법: netlab add <IP> <이름> [포트[:배너] ...] | netlab reset" >&2
    exit 1
    ;;
esac
`;

// nmap 은 자체 DNS 해석기를 써서 /etc/hosts 를 보지 않는다.
// 우리 환경엔 DNS 서버가 없으니 이름이 전부 실패한다.
// 진짜 서버에서는 DNS 로 이름이 풀리므로, 이건 실습 환경 때문에 생긴 인공적 차이다.
// --system-dns 를 기본으로 붙여 그 차이를 없앤다.
const NMAP_WRAP = `#!/bin/sh
exec /usr/bin/nmap --system-dns "$@"
`;

const fix = await boot({
    memory_size: 128 * 1024 * 1024,
    bzimage: img("images/boot/vmlinuz-lts"),
    initrd: img("images/boot/initramfs-min"),
    hda: img("images/dotslash-64.img"),
    cmdline: "console=ttyS0 root=/dev/sda1 rootfstype=ext4 rw init=/bin/sh",
}, { logPath: "serial-init.log", bootTimeout: 300000 });

await fix.run("mount -o remount,rw / ; mount -t proc proc /proc 2>/dev/null; mount -t devtmpfs dev /dev 2>/dev/null");
await writeFile(fix.run, "/sbin/runlevel-init", INIT);
await writeFile(fix.run, "/usr/local/bin/netlab", NETLAB);
await fix.run("chmod +x /usr/local/bin/netlab");
await writeFile(fix.run, "/usr/local/bin/nmap", NMAP_WRAP);
await fix.run("chmod +x /usr/local/bin/nmap");
report("init 교체", await fix.run(
    "chmod +x /sbin/runlevel-init && grep -c 'etc/runlevel/user' /sbin/runlevel-init"));

// 옛 이름의 흔적을 걷어낸다.
//
// 프로젝트 이름을 바꿀 때 게스트 안쪽은 "사용자 눈에 안 보인다"고 판단해 놔뒀는데,
// 그게 틀렸다. uname -a 에 hostname 이 나오고, ps 에는 PID 1 이 dotslash-init 으로,
// ls /etc 에는 /etc/dotslash 가 그대로 보인다. 리눅스 연습 사이트에서
// 사람들이 제일 먼저 치는 명령들이라 남겨둘 자리가 아니다.
// (localStorage 키는 그대로 둔다 — 눈에 안 보이고, 바꾸면 남의 진도가 날아간다.)
await fix.run([
    "rm -f /sbin/dotslash-init",
    "rm -rf /etc/dotslash",
    "echo runlevel > /etc/hostname",
    "sed -i 's/\\bdotslash\\b/runlevel/g' /etc/hosts",
].join("; ") + "; true");
report("옛 이름 흔적 (아무것도 없어야 정상)", await fix.run(
    "ls -d /sbin/dotslash-init /etc/dotslash 2>/dev/null; grep -l dotslash /etc/hosts /etc/hostname 2>/dev/null; echo '--끝--'"));
report("adduser 존재 확인", await fix.run("command -v adduser setsid"));

// 이미지를 만들면서 쌓인 셸 히스토리를 지운다.
//
// 이미지와 스냅샷은 누구나 받을 수 있다. /root/.ash_history 에 5.5KB 짜리
// 빌드 기록이 그대로 남아 있었다 — apk 명령, 저장소 주소, 이미지 다이어트 과정까지.
// 비밀은 없었지만 남한테 보여줄 물건에 들어갈 것은 아니다.
// (init 이 HISTFILE 를 비워두므로 새로 쌓이지는 않는다. 이건 그 전에 쌓인 것이다.)
// 이름을 하나씩 적지 않고 찾아서 지운다. 실제로 /.ash_history 를 놓쳤다 —
// 이 스크립트가 init=/bin/sh 로 부팅해서 HOME 이 없다 보니 ~ 가 / 로 잡혔고,
// 돌릴 때마다 거기에 쌓여 163KB 가 되어 있었다.
//
// 반드시 마지막 명령이어야 한다. 이 셸은 명령을 칠 때마다 히스토리에 덧붙이므로,
// 지운 뒤에 무엇이든 더 실행하면 그 자리에서 파일이 다시 생긴다
// (163KB -> 176B 로 줄기만 하고 0 이 안 됐던 이유다).
// 그래서 확인도 여기서 하지 않는다. 아래 두 채널 검증에서 다시 부팅해 확인한다 —
// 그 부팅은 dotslash-init 이 HISTFILE 를 비워두므로 히스토리를 남기지 않는다.
await fix.run("sync; find / -xdev \\( -name '.*history' -o -name '*_history' \\) -delete 2>/dev/null; sync; true");

const disk = Buffer.from(fix.emulator.v86.cpu.devices.ide.primary.master.buffer.buffer);
fs.writeFileSync("images/dotslash-64.img", disk);
fix.emulator.destroy?.();

// --- 두 채널이 다 뜨는지 검증 ---
console.log("\n두 채널 검증...");
const vm = await boot({
    memory_size: 128 * 1024 * 1024,
    uart1: true,
    bzimage: img("images/boot/vmlinuz-lts"),
    initrd: img("images/boot/initramfs-min"),
    hda: img("images/dotslash-64.img"),
    cmdline: "console=tty0 console=ttyS0 root=/dev/sda1 rootfstype=ext4 rw init=/sbin/runlevel-init",
}, { logPath: "serial-init2.log", bootTimeout: 300000 });

// --- 채점 채널(ttyS1) 준비. root 고정이라 계정 전환과 무관하게 늘 쓸 수 있다 ---
let s1 = "";
vm.emulator.add_listener("serial1-output-byte", (b) => (s1 += String.fromCharCode(b)));
const send1 = (s) => vm.emulator.serial_send_bytes(1, new TextEncoder().encode(s));

// 채점 채널 왕복. 사용자 셸이 무슨 상태든 영향받지 않는다.
async function runG(cmd, timeout = 20000) {
    const from = s1.length;
    send1(`echo "__G""__"; ${cmd}; echo "__GC""__$?"\n`);
    const deadline = Date.now() + timeout;
    for (;;) {
        const m = s1.slice(from).match(/__GC__(\d+)/);
        if (m) {
            const chunk = s1.slice(from);
            const start = chunk.indexOf("__G__") + "__G__".length;
            return { exit: Number(m[1]), out: chunk.slice(start, chunk.indexOf("__GC__")).replace(/\r/g, "").trim() };
        }
        if (Date.now() > deadline) return { exit: null, out: "", timedOut: true };
        await new Promise((r) => setTimeout(r, 50));
    }
}

report("[ttyS1] 채점 채널 계정", await runG("id -un"));
report("[ttyS0] student 계정 존재", await runG("id student"));

// 빌드 잔재가 이미지에 남아 있으면 안 된다. 스냅샷은 누구나 받을 수 있다.
// 이 부팅은 히스토리를 남기지 않으므로 여기서 재는 값이 진짜다.
report("남은 히스토리 파일 (아무것도 없어야 정상)", await runG(
    "find / -xdev \\( -name '.*history' -o -name '*_history' \\) -exec ls -l {} \\; 2>/dev/null; echo '--끝--'"));

// exit 를 쳐도 커널 패닉이 안 나고 셸이 다시 떠야 한다
vm.emulator.serial0_send("exit\n");
await new Promise((r) => setTimeout(r, 3000));
console.log(`[exit 내성] 커널 패닉: ${/Kernel panic/.test(vm.serial()) ? "발생 (문제)" : "없음 (정상)"}`);

// --- 계정 전환 ---
// 현재 계정은 init 이 남기는 파일을 채점 채널로 읽는다.
// 사용자 터미널에 물어보면 확인할 때마다 Ctrl-C 가 화면에 찍힌다.
const whoami = async () => (await runG("cat /etc/runlevel/current")).out.trim() || "(없음)";
const switchTo = async (u) => {
    await runG(`echo '${u}' > /etc/runlevel/user`);
    // ^C 와 명령을 붙여 보내면 안 된다. bash 의 readline 이 SIGINT 를 받아
    // 줄을 다시 그리는 동안 들어온 입력을 흘려서 첫 글자가 사라진다
    // ("exit" -> "xit: command not found"). web/vm.js 의 sendAfterInterrupt 와 같은 이유다.
    vm.emulator.serial0_send("\x03");
    await new Promise((r) => setTimeout(r, 400));
    vm.emulator.serial0_send("exit\n");
    for (let i = 0; i < 60; i++) {
        if (await whoami() === u) return;
        await new Promise((r) => setTimeout(r, 200));
    }
};

console.log(`\n[계정] 초기: ${await whoami()}`);
await switchTo("student");
const asStudent = await whoami();
console.log(`[계정] student 로 전환: ${asStudent}`);

// student 가 /work 에 실제로 파일을 만들 수 있어야 한다
const canWrite = await runG("su -s /bin/sh student -c 'touch /work/probe && echo yes'");
console.log(`[권한] student 가 /work 에 쓰기: ${canWrite.out.includes("yes") ? "가능 (정상)" : "불가 (문제)"}`);

// 권한 문제가 의미를 가지려면 student 가 실제로 막혀야 한다
await runG("echo secret > /work/locked.txt && chmod 600 /work/locked.txt && chown root /work/locked.txt");
const blocked = await runG("su -s /bin/sh student -c 'cat /work/locked.txt' 2>/dev/null");
console.log(`[권한] student 가 600 root 파일 읽기: ${blocked.exit === 0 ? "읽힘 (문제)" : "차단됨 (정상)"}`);
await runG("rm -f /work/locked.txt /work/probe");

await switchTo("root");
console.log(`[계정] root 로 복귀: ${await whoami()}`);

// ^C 로 실행 중인 명령을 멈출 수 있어야 한다.
// 제어 터미널이 없으면 커널이 SIGINT 를 전달하지 못해 ping 이 영원히 돈다.
vm.emulator.serial0_send("ping 127.0.0.1\n");
await new Promise((r) => setTimeout(r, 2500));
vm.emulator.serial_send_bytes(0, new TextEncoder().encode("\x03"));
await new Promise((r) => setTimeout(r, 1500));
const stillPinging = (await runG("ps -o args | grep -c '[p]ing 127'")).out;
console.log(`[^C] 실행 중인 명령 중단: ${stillPinging === "0" ? "됨 (정상)" : "안 됨 (문제)"}`);
await runG("pkill -9 -f 'ping 127' 2>/dev/null; true");

// 채점 채널에서 친 명령이 사용자 화면에 안 보이는지
const before = vm.serial().length;
await runG('echo "__HIDDEN""__TEST"');
console.log(`[격리] 채점 명령이 ttyS0 에 샜는가: ${vm.serial().slice(before).includes("__HIDDEN__TEST") ? "샜음 (문제)" : "안 샘 (정상)"}`);

// 계정 전환을 여러 번 해도 사용자 화면에 Ctrl-C 가 쌓이지 않아야 한다.
// 전환 1회당 ^C 1개까지만 허용한다.
const ctrlCBefore = (vm.serial().match(/\^C/g) ?? []).length;
await switchTo("student");
await switchTo("root");
await switchTo("student");
const added = (vm.serial().match(/\^C/g) ?? []).length - ctrlCBefore;
console.log(`[화면] 전환 3회 동안 찍힌 ^C: ${added}개 ${added <= 3 ? "(정상)" : "(과다 — 폴링이 사용자 채널을 두드리는 중)"}`);

process.exit(0);
