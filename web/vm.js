// v86 게스트 제어. 화면(ttyS0)과 채점(ttyS1)을 분리해서 다룬다.
//
// ttyS0 — 사용자 터미널. xterm 에 그대로 연결된다.
// ttyS1 — 채점 채널. root 셸이 붙어 있고 사용자 화면에는 절대 나타나지 않는다.
//         덕분에 사용자가 명령을 치는 도중에 채점해도 서로 간섭하지 않는다.
//
// 채점 왕복 프로토콜은 spike/harness.mjs 와 비슷하지만 같지 않다.
// 여기는 명령을 항상 base64 로 감싸고 표식을 payload 안에 넣는다 (runNow 주석 참고).
// harness 는 한 줄짜리를 그대로 보내서 그 문제를 안 겪는다 — 그래서 게스트를 부순 뒤
// harness 로 재현하면 정상으로 보이고 브라우저에서만 깨진다. 실제로 그렇게 헤맸다.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

// T2 문제용 스크래치 디스크 크기. 문제 YAML 의 size 와 맞춰야 한다.
export const SCRATCH_MB = 64;
const SCRATCH_BYTES = SCRATCH_MB * 1024 * 1024;
const DISK_BYTES = 64 * 1024 * 1024;      // 루트 디스크 크기. 스냅샷 복원 때 껍데기로 쓴다

// 디스크 이미지는 128MB 지만 대부분이 빈 공간이라 gzip 으로 12MB 가 된다.
// 호스트의 압축 설정에 기대지 않고 직접 받아서 푼다 — 정적 호스팅이면 어디든 똑같이 동작한다.
// (GitHub Pages 는 application/octet-stream 을 압축해주지 않는다.)
async function fetchDisk(url, onBytes) {
    const gz = await fetch(`${url}.gz`);
    if (!gz.ok) return { url };                       // .gz 가 없으면 v86 이 직접 받게 둔다

    const total = Number(gz.headers.get("content-length")) || 0;
    let got = 0;
    const counted = new TransformStream({
        transform(chunk, ctrl) { got += chunk.byteLength; onBytes?.(got, total); ctrl.enqueue(chunk); },
    });
    const stream = gz.body.pipeThrough(counted).pipeThrough(new DecompressionStream("gzip"));
    return { buffer: await new Response(stream).arrayBuffer() };
}

// 루트 파일시스템의 UUID 를 이미지에서 직접 읽는다 (MBR 1번 파티션의 ext 슈퍼블록).
//
// 디스크 이름(sda/sdb)은 initramfs 가 확정해주지만(make-initramfs.mjs 참고),
// 루트는 이름에 기대지 않는 편이 낫다. 이름이 한 번 어긋나면 빈 스크래치 디스크를
// 루트로 잡고 복구 셸에 떨어져서 부팅이 아예 끝나지 않기 때문이다.
//
// 이미지가 이미 메모리에 있으므로 UUID 를 상수로 박아두지 않고 그때그때 읽는다
// — 이미지를 다시 만들어도 따라 바뀐다.
function rootUuid(buffer) {
    if (!buffer) return null;
    const dv = new DataView(buffer);
    if (dv.getUint16(510, true) !== 0xaa55) return null;          // MBR 이 아니다
    const sb = dv.getUint32(446 + 8, true) * 512 + 1024;          // 1번 파티션 + 슈퍼블록 오프셋
    if (dv.getUint16(sb + 56, true) !== 0xef53) return null;      // ext 매직이 아니다
    const hex = [...new Uint8Array(buffer, sb + 104, 16)]
        .map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// 스크래치 디스크는 "루트가 올라오지 않은 디스크"로 찾는다.
// 이름 배정이 뒤집힌 부팅에서는 루트가 sdb, 스크래치가 sda 가 된다.
export const FIND_SCRATCH = [
    'ROOTDISK=$(findmnt -no SOURCE / | sed "s/[0-9]*$//")',
    'for d in /sys/block/sd*; do',
    '    [ "/dev/${d##*/}" = "$ROOTDISK" ] || { echo "/dev/${d##*/}"; break; }',
    'done',
].join("\n");

export async function createVM({ screenContainer, onUserOutput, onProgress, onDiskProgress, onClear }) {
    let userSerial = "";     // ttyS0 누적
    let gradeSerial = "";    // ttyS1 누적
    let lastUserOutputAt = 0;
    let muted = false;       // 문제 전환 중 화면 갱신을 잠시 끊는다

    // 기본은 스냅샷 복원이다.
    //
    // v86 은 순수 CPU 에뮬레이션이라 부팅 6초가 기기 성능에 그대로 비례한다.
    // 4배 느린 CPU 에서 45초까지 늘어나는 것을 실측했다.
    // 스냅샷은 부팅 과정 자체를 없애서, 압축 해제 + 메모리 복사만 남긴다.
    //
    // 스냅샷에는 디스크 내용도 들어 있다. 그래서 커널·initramfs·디스크 이미지를
    // 따로 받지 않아도 되고, 빈 껍데기만 같은 크기로 붙여주면 된다.
    // (?boot=1 을 붙이면 예전처럼 실제 부팅 과정을 볼 수 있다)
    const useSnapshot = !new URLSearchParams(location.search).has("boot");

    const tFetch = Date.now();
    const hda = useSnapshot
        ? { buffer: new ArrayBuffer(DISK_BYTES) }          // 스냅샷이 내용을 채워준다
        : await fetchDisk("img/dotslash-64.img", onDiskProgress);
    const hdb = { buffer: new ArrayBuffer(SCRATCH_BYTES) };
    const diskMs = Date.now() - tFetch;

    const uuid = useSnapshot ? null : rootUuid(hda.buffer);
    const root = uuid ? `UUID=${uuid}` : "/dev/sda1";

    const bootOpts = {
        bzimage: { url: "img/boot/vmlinuz-lts" },
        initrd: { url: "img/boot/initramfs-min" },
        // scsi_mod.scan=sync — 이름을 확정하는 건 initramfs 쪽이지만(make-initramfs.mjs 참고),
        // 그게 동작하려면 SCSI 장치 목록이 그 시점에 완성돼 있어야 한다.
        cmdline: `console=tty0 console=ttyS0 root=${root} rootfstype=ext4 rw `
               + `scsi_mod.scan=sync init=/sbin/runlevel-init`,
    };

    const emulator = new V86({
        wasm_path: "vendor/v86.wasm",
        memory_size: 128 * 1024 * 1024,
        vga_memory_size: 2 * 1024 * 1024,
        screen_container: screenContainer,
        uart1: true,                       // 채점 전용 채널

        // v86 의 키보드·마우스 어댑터를 만들지 않는다.
        //
        // 그것들은 window 에 keydown/keyup/mousedown 리스너를 걸고, 잡은 키를
        // 게스트의 PS/2 키보드로 넘기면서 preventDefault 를 부른다.
        // 그런데 이 앱은 게스트에 입력을 시리얼(ttyS0)로 보낸다 — PS/2 는 안 쓴다.
        // 남의 키를 뺏기만 하고 아무 일도 안 하는 셈이다.
        //
        // 실제로 홈 화면에서 아무 입력칸에도 포커스가 없을 때 Cmd+W · Cmd+T 가
        // 이 리스너에 먹혔다. 터미널 안에서는 xterm 의 textarea 가 포커스를 쥐고
        // 있어서 티가 안 났고, 그래서 "홈에서만" 안 되는 것처럼 보였다.
        disable_keyboard: true,
        disable_mouse: true,
        bios: { url: "img/seabios.bin" },
        vga_bios: { url: "img/vgabios.bin" },
        hda,
        hdb,
        ...(useSnapshot
            // .zst 는 v86 이 알아서 푼다
            ? { initial_state: { url: "img/state.bin.zst" } }
            : bootOpts),
        autostart: true,
    });

    // 시리얼은 바이트 단위로 들어온다. 한 바이트씩 문자로 바꾸면
    // 한글처럼 여러 바이트를 쓰는 글자가 깨진다.
    // 바이트를 모아서 UTF-8 로 해석하고, 화면에는 바이트 그대로 넘긴다
    // (xterm 이 UTF-8 을 직접 처리한다).
    const userDec = new TextDecoder("utf-8");
    const gradeDec = new TextDecoder("utf-8");
    let userBuf = [];
    let flushQueued = false;

    const flushUser = () => {
        flushQueued = false;
        if (!userBuf.length) return;
        const bytes = new Uint8Array(userBuf);
        userBuf = [];
        userSerial += userDec.decode(bytes, { stream: true });
        if (!muted) onUserOutput?.(bytes);
    };

    emulator.add_listener("serial0-output-byte", (b) => {
        userBuf.push(b);
        lastUserOutputAt = Date.now();
        if (!flushQueued) { flushQueued = true; queueMicrotask(flushUser); }
    });
    emulator.add_listener("serial1-output-byte", (b) => {
        gradeSerial += gradeDec.decode(new Uint8Array([b]), { stream: true });
    });
    if (onProgress) emulator.add_listener("download-progress", onProgress);

    // 문자열을 그대로 넘기는 serial0_send 는 비ASCII 를 깨뜨린다.
    // 깨진 바이트가 따옴표를 어긋나게 하면 셸이 연속 입력(>) 상태에 갇혀 되돌아오지 못한다.
    const enc = new TextEncoder();
    const sendUser  = (s) => emulator.serial_send_bytes(0, enc.encode(s));
    const sendGrade = (s) => emulator.serial_send_bytes(1, enc.encode(s));

    async function waitFor(getBuf, re, { timeout = 60000, from = 0 } = {}) {
        const deadline = Date.now() + timeout;
        for (;;) {
            const m = getBuf().slice(from).match(re);
            if (m) return m;
            if (Date.now() > deadline) return null;
            await sleep(50);
        }
    }

    // 채점 채널에서 명령을 실행하고 exit code 와 출력을 회수한다.
    //
    // 명령은 base64 로 감싸 보낸다. 여러 줄짜리 스크립트를 그대로 흘려보내면
    // 마지막 "; echo __CHK__$?" 가 다음 줄에 홀로 남아 syntax error 가 나고,
    // 마커를 영영 못 받아 타임아웃까지 대기하게 된다.
    // 마커에 일련번호를 붙여 자기 명령의 결과만 받는다.
    //
    // 번호가 없으면 타임아웃된 명령의 마커가 뒤늦게 도착했을 때 다음 명령이 그걸
    // 자기 결과로 읽는다. waitReady 가 부팅 대기 중에 3초 타임아웃으로 run 을
    // 반복 호출하므로 이 상황이 실제로 생긴다 — 검증에서 file-01 의 첫 조건이
    // 풀기 전부터 통과로 잡히는 것으로 드러났다 (간헐적, 재현 1/2회).
    //
    // 그리고 한 번에 하나씩만 보낸다. 채널은 하나인데 부르는 곳은 여럿이다 —
    // 채점, 파일트리, 터미널 크기 조절(stty), 계정 확인이 각자 run 을 부른다.
    // 겹치면 한쪽 명령의 에코가 다른 쪽 출력 구간에 섞여 들어간다.
    //
    // 실제로 그렇게 깨졌다:
    //   · 파일트리 자리에 stty 명령이 통째로 찍혔다
    //   · setup 스크립트가 절반만 돌았는데 exit 0 으로 보고돼서, 문제가
    //     시작부터 목표 2개 통과 + 유지 조건 깨짐 상태로 떴다
    //
    // 순서를 강제하면 이 부류가 통째로 사라진다. 게스트가 한 번에 명령 하나만
    // 처리하므로 병렬로 보내봐야 어차피 빨라지지도 않는다.
    let seq = 0;
    let queue = Promise.resolve();
    function run(cmd, timeout = 30000) {
        const mine = queue.then(() => runNow(cmd, timeout));
        // 하나가 실패해도 뒤가 막히면 안 된다
        queue = mine.catch(() => {});
        return mine;
    }

    async function runNow(cmd, timeout) {
        const id = ++seq;
        const from = gradeSerial.length;
        // 시작 표식을 payload 안에 넣는다. 이게 핵심이다.
        //
        // 명령은 base64 로 감싸 보내는데, base64 자체가 게스트의 실행 파일이다.
        // 사용자가 rm -rf / 를 하면 base64 가 사라지고 $( ) 가 빈 문자열이 되며,
        // eval "" 는 아무것도 안 하고 조용히 0 을 돌려준다.
        //
        // 그러면 모든 채점 조건이 "통과"로 보고된다. 실측한 결과다 —
        // 시스템을 부수면 목표 3개와 유지 조건이 전부 ok 로 뒤집히고 문제가 통과됐다.
        // "게스트가 멀쩡한가"를 묻는 확인조차 같은 경로라 멀쩡하다고 답했다.
        //
        // 표식을 바깥(sendGrade 줄)에 두면 디코딩 실패와 구분이 안 된다.
        // 안에 넣으면 디코딩이 안 됐을 때 표식도 같이 사라지므로 그것으로 판별한다.
        const payload = `echo "__GO""__${id}__"\n${cmd}`;
        sendGrade(`eval "$(printf %s '${b64(payload)}' | base64 -d)"; echo "__CHK""__${id}__$?"\n`);
        const m = await waitFor(() => gradeSerial, new RegExp(`__CHK__${id}__(\\d+)`), { timeout, from });
        if (!m) {
            // 셸이 이상한 상태일 수 있다. 다음 채점까지 말려들지 않게 끊어준다.
            sendGrade("\x03");
            return { cmd, exit: null, out: "", timedOut: true };
        }
        const chunk = gradeSerial.slice(from);
        const goMark = `__GO__${id}__`;
        const at = chunk.indexOf(goMark);
        if (at < 0) {
            // 명령이 아예 실행되지 않았다. exit code 를 믿으면 안 된다.
            return { cmd, exit: null, out: "", noRun: true };
        }
        return {
            cmd,
            exit: Number(m[1]),
            out: chunk.slice(at + goMark.length, chunk.indexOf(`__CHK__${id}__`)).replace(/\r/g, "").trim(),
        };
    }

    // 커널이 콘솔(= 사용자 터미널 ttyS0)에 찍는 메시지를 잠재운다.
    //
    // 탭이 뒤로 넘어가면 브라우저가 타이머를 초당 1회까지 늦춘다. 에뮬레이션이 그만큼
    // 멈췄다가 돌아오면 게스트 입장에서는 시간이 통째로 건너뛴 것이라,
    // watchdog 이 "BUG: soft lockup - CPU#0 stuck for 25s" 를 콜 트레이스까지 붙여 뱉는다.
    // 그게 사용자가 치던 줄 한가운데 끼어든다 (문제점.md case 14).
    //
    // 진짜로 멈춘 게 아니라 브라우저가 재워둔 것이므로 감시할 이유가 없다.
    // loglevel 만 낮춰서는 안 된다 — soft lockup 은 KERN_EMERG 라 그 문턱을 안 탄다.
    // 반대로 watchdog 만 꺼도 안 된다 — "sched: DL replenish lagged too much" 는
    // 같은 시간 점프에서 나오는 별개의 메시지다. 둘 다 필요하다.
    const QUIET_CONSOLE = [
        // dmesg -n 1 과 같다. 파일에 직접 쓰면 dmesg 구현(busybox/util-linux)을 안 탄다.
        "echo 1 > /proc/sys/kernel/printk",
        "echo 0 > /proc/sys/kernel/watchdog",
        "true",
    ].join("; ");

    // 두 채널이 다 응답할 때까지 기다린다
    async function waitReady(timeoutMs = 300000) {
        const deadline = Date.now() + timeoutMs;
        let userOk = false;
        while (Date.now() < deadline) {
            if (!userOk) {
                const from = userSerial.length;
                // 앞 공백은 의도적이다. 이 줄은 사용자 셸로 가므로 그냥 보내면
                // 사람이 친 것처럼 history 에 남는다 (HISTCONTROL=ignorespace).
                sendUser(' echo "__BOOT""_OK__"\n');
                if (await waitFor(() => userSerial, /__BOOT_OK__/, { timeout: 1500, from })) userOk = true;
            }
            if (userOk) {
                const r = await run("echo ready", 3000);
                if (r.exit === 0) {
                    await run(QUIET_CONSOLE, 5000);
                    return true;
                }
            }
        }
        return false;
    }

    // 사용자 셸의 계정을 바꾼다.
    // init 이 매 바퀴 /etc/runlevel/user 를 다시 읽으므로, 파일을 고치고
    // 셸을 종료시키면 다음 바퀴에서 새 계정으로 뜬다.
    //
    // 전환이 끝났는지는 init 이 남기는 /etc/runlevel/current 를 채점 채널로 읽어 확인한다.
    // 사용자 터미널에 대고 물어보면 확인 때마다 Ctrl-C 와 프롬프트가 화면에 찍힌다.
    // ttyS0 을 붙들고 있는 프로세스를 전부 정리한다.
    // vi 가 떠 있거나 sudo -s 로 중첩 셸에 들어가 있으면 exit 한 번으로는
    // 셸이 안 죽어서 계정 전환이 영영 안 끝난다.
    // PID 1(init)과 채점 채널(ttyS1)은 건드리지 않는다.
    const KILL_TTY0 = `
for d in /proc/[0-9]*; do
    pid=\${d#/proc/}
    [ "$pid" = 1 ] && continue
    case "$(readlink $d/fd/0 2>/dev/null)" in
        */ttyS0) kill -9 "$pid" 2>/dev/null ;;
    esac
done
true`;

    // 사용자 셸(ttyS0)의 PID. 로그인 셸은 init 이 setsid 로 띄우므로 세션 리더다
    // (세션 ID == 자기 PID). vi 나 sudo -s 로 들어간 중첩 셸은 같은 세션이지만
    // 세션 리더가 아니라서 이걸로 구분된다.
    //
    // ps 로는 못 찾는다 — 이 busybox 의 ps 는 tty 칸을 늘 "?" 로 찍는다.
    // (그래서 예전 resetCwd 의 확인이 늘 빈 문자열을 보고 5번 재시도만 하고 있었다.)
    const USER_SHELL_PID = `
for d in /proc/[0-9]*; do
    pid=\${d#/proc/}
    [ "$pid" = 1 ] && continue
    case "$(readlink $d/fd/0 2>/dev/null)" in
        */ttyS0) ;;
        *) continue ;;
    esac
    [ "$(awk '{print $6}' $d/stat 2>/dev/null)" = "$pid" ] || continue
    echo "$pid"
    break
done`;

    // 셸 앞에 나와 있는 프로그램을 정리한다 (vi, sudo -s 로 들어간 중첩 셸 …).
    // 로그인 셸 자신은 남긴다 — 죽이면 init 이 다시 띄우는 동안 화면이 한 번 더 출렁인다.
    const KILL_FOREGROUND = `
for d in /proc/[0-9]*; do
    pid=\${d#/proc/}
    [ "$pid" = 1 ] && continue
    case "$(readlink $d/fd/0 2>/dev/null)" in
        */ttyS0) ;;
        *) continue ;;
    esac
    [ "$(awk '{print $6}' $d/stat 2>/dev/null)" = "$pid" ] && continue
    kill -9 "$pid" 2>/dev/null
done
# 강제로 죽은 프로그램은 터미널 설정을 되돌리지 못한다 (vi 는 raw 모드로 바꿔둔다)
stty -F /dev/ttyS0 sane 2>/dev/null
true`;

    async function currentUserName() {
        return (await run("cat /etc/runlevel/current 2>/dev/null", 5000)).out.trim();
    }

    async function userCwd() {
        const r = await run(`p=$(${USER_SHELL_PID}); [ -n "$p" ] && readlink -f "/proc/$p/cwd"`, 8000);
        return r.exit === 0 ? r.out.trim() : "";
    }

    // Ctrl-C 를 보낸 뒤 곧바로 글자를 이어 보내면 첫 글자가 사라진다.
    //
    // 사용자 셸이 bash 라 readline 이 붙어 있고, SIGINT 를 받아 줄을 다시 그리는 동안
    // 들어온 입력을 흘린다. 실측: "\x03exit\n" 을 보내면 화면에는 exit 가 찍히는데
    // 셸은 "bash: xit: command not found" 라고 답한다. 그 결과 계정 전환이 통째로 실패했다.
    // (busybox sh 를 쓰던 때는 이 문제가 없어서 한 번에 보냈다.)
    //
    // 지연을 감으로 주지 않는다. ^C 는 반드시 무언가를 찍으므로,
    // 그 출력이 도착한 뒤 잦아드는 것을 보고 나서 나머지를 보낸다.
    async function sendAfterInterrupt(text, { quiet = 120, max = 2500 } = {}) {
        const from = userSerial.length;
        sendUser("\x03");
        const deadline = Date.now() + max;
        while (Date.now() < deadline && userSerial.length === from) await sleep(30);
        while (Date.now() < deadline && Date.now() - lastUserOutputAt < quiet) await sleep(30);
        sendUser(text);
    }

    // force 는 "같은 계정이어도 셸을 새로 띄운다" 는 뜻이다.
    //
    // 그룹 소속은 로그인할 때 정해진다. setup 이 adduser 로 그룹에 넣어도
    // 이미 떠 있는 셸은 그걸 모른다 — 실제 리눅스에서 그룹을 바꾼 뒤
    // 다시 로그인해야 반영되는 것과 같은 이유다.
    // (perm-03 이 그래서 브라우저에서만 실패했다. 노드 테스트는 매번 su 로
    //  새로 띄우므로 이 차이가 안 드러났다.)
    async function switchUser(user, { force = false } = {}) {
        const same = await currentUserName() === user;
        if (same && !force) return;
        await run(`echo '${user}' > /etc/runlevel/user`);

        // 계정이 그대로면 "계정이 바뀌었나"로는 완료를 알 수 없다.
        // 셸이 실제로 새로 떴는지는 PID 가 바뀌는 것으로 본다.
        const pid = async () => (await run(USER_SHELL_PID, 8000)).out.trim();
        const before = same ? await pid() : null;
        const done = async () =>
            (await currentUserName()) === user && (!same || (await pid()) !== before);

        // 1단계: 얌전히 나가달라고 한다 (Ctrl-C 로 입력하다 만 줄부터 지운다)
        await sendAfterInterrupt(" exit\n");
        for (let i = 0; i < 20; i++) {
            if (await done()) return;
            await sleep(150);
        }

        // 2단계: 안 나가면 강제로 정리한다
        await run(KILL_TTY0, 10000);
        for (let i = 0; i < 40; i++) {
            if (await done()) return;
            await sleep(150);
        }
        throw new Error(`계정 전환 실패: ${user}`);
    }

    return {
        emulator,
        diskMs,                        // 디스크 이미지 받고 푸는 데 걸린 시간
        run,
        waitReady,
        switchUser,
        currentUser: async () => (await run("cat /etc/runlevel/current 2>/dev/null")).out.trim(),
        setMuted: (v) => (muted = v),

        // 시리얼 포트에는 창 크기를 알려줄 방법이 없다. 그래서 게스트는 늘 80x24 로
        // 가정하고, vi 같은 전체화면 프로그램이 실제 창과 어긋나게 그린다.
        // 채점 채널에서 ttyS0 의 크기를 직접 지정해 맞춰준다 (사용자 화면에는 안 보인다).
        async setTermSize(cols, rows) {
            if (!(cols > 0 && rows > 0)) return;
            await run(`stty -F /dev/ttyS0 cols ${cols} rows ${rows} 2>/dev/null; true`, 5000);
        },
        // 사용자 셸을 문제가 지정한 디렉터리로 되돌린다.
        //
        // 그냥 "cd /work\n" 을 보내면 안 된다. 사용자가 입력하다 만 줄이 남아 있으면
        // 거기에 이어붙어 엉뚱한 명령이 되고, cd 는 조용히 무시된다.
        // (실제로 /etc 에서 문제를 바꿔도 /etc 에 그대로 남는 일이 있었다.)
        // Ctrl-C 로 줄을 비우고, 실제로 옮겨졌는지 확인될 때까지 재시도한다.
        async resetCwd(dir) {
            for (let i = 0; i < 5; i++) {
                await sendAfterInterrupt(` cd '${dir}' 2>/dev/null\n`);
                await sleep(200);
                // 사용자 셸의 실제 cwd 는 /proc 으로 확인한다.
                // 화면에 물어보면 그 출력이 사용자에게 보인다.
                if (await userCwd() === dir) return true;
            }
            return false;
        },

        // 사용자 셸이 지금 어느 디렉터리에 있는지. 파일트리가 이걸 따라간다.
        userCwd,

        // 셸 앞에 나와 있는 프로그램(vi, 중첩 셸 …)을 치운다.
        // 문제를 바꿀 때 이걸 안 하면 이후의 ^C·cd 가 전부 그 프로그램으로 들어간다.
        cleanupForeground: () => run(KILL_FOREGROUND, 10000),

        // 화면을 비우고 프롬프트를 새로 그린다.
        //
        // "출력이 잦아들 때까지" 기다리는 방식은 여기서 쓸 수 없다.
        // 아직 아무 출력도 오지 않은 상태가 이미 "조용함"이라 즉시 통과해버려서,
        // 프롬프트가 그려지기 전에 제어가 넘어간다.
        // 새 출력이 실제로 도착한 뒤에 잦아드는 것을 확인해야 한다.
        async clearScreen(timeout = 3000) {
            onClear?.();
            const from = userSerial.length;
            sendUser("\n");
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                if (userSerial.length > from && Date.now() - lastUserOutputAt >= 150) return true;
                await sleep(40);
            }
            return false;
        },
        sendUser,
        waitFor,
        // 사용자 셸이 지금까지 받은 입력을 전부 처리했는지 확인한다.
        // 셸은 입력을 순서대로 처리하므로 센티넬이 돌아오면 앞 명령이 다 끝난 것이다.
        async waitUserEcho(timeout = 60000) {
            const from = userSerial.length;
            sendUser('echo "__IDLE""__"\n');
            return !!(await waitFor(() => userSerial, /__IDLE__/, { timeout, from }));
        },
        userSerial: () => userSerial,

        // 부팅 중 진행 상황을 한 줄로. 커널 로그가 ttyS0 에도 나오므로 그대로 쓸 수 있다.
        // 우리가 보낸 확인용 명령의 에코(__ 가 들어간 줄)는 걸러낸다.
        lastLine: () => {
            const lines = userSerial.replace(/\r/g, "").split("\n");
            for (let i = lines.length - 1; i >= 0; i--) {
                const l = lines[i].trim();
                if (l && !l.includes("__") && !l.endsWith("#") && !l.endsWith("$")) {
                    return l.length > 64 ? l.slice(-64) : l;
                }
            }
            return "";
        },
        // 사용자 출력이 조용해질 때까지 (명령이 끝났다는 신호)
        async waitQuiet(ms = 400, max = 10000) {
            const deadline = Date.now() + max;
            while (Date.now() < deadline) {
                if (Date.now() - lastUserOutputAt >= ms) return true;
                await sleep(80);
            }
            return false;
        },
    };
}

// 게스트에 파일을 쓴다. 따옴표/줄바꿈 문제를 피하려고 base64 로 넘긴다.
export function writeFileCmd(path, content) {
    const dir = path.replace(/\/[^/]*$/, "");
    return `mkdir -p '${dir}' && printf %s '${b64(content)}' | base64 -d > '${path}'`;
}
