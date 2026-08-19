// v86을 Node에서 부팅하고 시리얼로 명령을 주고받는 하네스.
// 채점 파이프라인의 원형이라 그대로 제품으로 이어진다.

import fs from "node:fs";
import { V86 } from "v86";

export const img = (p) => {
    const b = fs.readFileSync(p);
    return { buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function boot(opts = {}, { logPath = "serial.log", bootTimeout = 120000, login = null } = {}) {
    let serial = "";
    const logStream = logPath ? fs.createWriteStream(logPath) : null;

    const emulator = new V86({
        wasm_path: "node_modules/v86/build/v86.wasm",
        memory_size: 128 * 1024 * 1024,
        vga_memory_size: 2 * 1024 * 1024,
        bios: img("images/seabios.bin"),
        vga_bios: img("images/vgabios.bin"),
        autostart: true,
        ...opts,
    });

    emulator.add_listener("serial0-output-byte", (byte) => {
        const ch = String.fromCharCode(byte);
        serial += ch;
        logStream?.write(ch);
    });

    async function waitFor(re, { timeout = 60000, from = 0 } = {}) {
        const deadline = Date.now() + timeout;
        for (;;) {
            const m = serial.slice(from).match(re);
            if (m) return m;
            if (Date.now() > deadline) return null;
            await sleep(100);
        }
    }

    // 마커를 "__RUN" + "__" 처럼 쪼개 보낸다.
    // 에코된 명령줄에는 마커가 안 보이고 실행 결과에만 나타나므로 오탐이 없다.
    // 시작 마커가 따로 있어야 명령줄이 80칸에서 줄바꿈돼도 출력에 안 섞인다.
    //
    // 여러 줄짜리 명령은 base64 로 감싸 한 줄로 만든다. 그냥 흘려보내면
    // 마지막 "; echo __CHK__$?" 가 다음 줄에 홀로 남아 syntax error 가 나고,
    // 마커를 영영 못 받아 타임아웃까지 대기하게 된다.
    //
    // 단 tty 라인 버퍼에 한계가 있어 무한정 길게는 못 보낸다.
    // 큰 내용을 게스트에 넣을 때는 writeFile() 로 쪼개 보낼 것.

    // serial0_send 는 문자열을 그대로 넘겨 비ASCII 를 깨뜨린다.
    // 깨진 바이트가 따옴표를 어긋나게 하면 셸이 연속 입력(>) 상태에 영구히 갇힌다.
    const send = (s) => emulator.serial_send_bytes(0, new TextEncoder().encode(s));

    // 마커에는 일련번호를 붙인다. 번호가 없으면 타임아웃된 명령의 마커가 뒤늦게
    // 도착했을 때 다음 명령이 그걸 자기 결과로 읽는다 (web/vm.js 에서 실측된 버그다).
    let seq = 0;
    async function run(cmd, timeout = 120000) {
        const id = ++seq;
        const from = serial.length;
        const payload = cmd.includes("\n")
            ? `eval "$(printf %s '${Buffer.from(cmd).toString("base64")}' | base64 -d)"`
            : cmd;
        // 맨 앞 공백은 실수가 아니다. 이 채널은 사용자 셸(ttyS0)이라,
        // 여기서 보낸 것이 사람이 친 것처럼 history 에 쌓인다.
        // HISTCONTROL=ignorespace 를 걸어뒀으므로 공백 하나로 빠진다.
        // (스냅샷을 만들 때 이 채널을 쓰는데, 그 명령들이 통째로 얼어붙어
        //  사용자가 history 를 치면 __RUN__ 표식과 base64 덩어리가 쏟아졌다.)
        send(` echo "__RUN""__${id}__"; ${payload}; echo "__CHK""__${id}__$?"\n`);
        const m = await waitFor(new RegExp(`__CHK__${id}__(\\d+)`), { timeout, from });
        if (!m) {
            // 셸이 이상한 상태에 빠졌을 수 있다. 다음 명령까지 말려들지 않게 끊어준다.
            send("\x03");
            return { cmd, exit: null, out: serial.slice(from).trim(), timedOut: true };
        }
        const chunk = serial.slice(from);
        const runMark = `__RUN__${id}__`;
        const start = chunk.indexOf(runMark) + runMark.length;
        const out = chunk
            .slice(start, chunk.indexOf(`__CHK__${id}__`))
            .replace(/\r/g, "").trim();
        return { cmd, exit: Number(m[1]), out };
    }

    // getty가 뜨는 이미지(Alpine 등)는 먼저 로그인해야 셸이 나온다
    if (login) {
        if (await waitFor(/login:/, { timeout: bootTimeout })) {
            send(`${login}\n`);
            await sleep(2000);
        }
    }

    // 셸이 뜰 때까지 부팅 마커를 반복 전송
    const deadline = Date.now() + bootTimeout;
    while (Date.now() < deadline) {
        const from = serial.length;
        send('echo "__BOOT""_OK__"\n');
        if (await waitFor(/__BOOT_OK__/, { timeout: 2000, from })) {
            return { emulator, run, waitFor, serial: () => serial, logStream };
        }
    }
    throw new Error(`부팅 실패. 시리얼 마지막 2000자:\n${serial.slice(-2000)}`);
}

// 게스트에 파일을 쓴다. base64 를 조각내 이어붙인다.
// tty 라인 버퍼 한계 때문에 한 줄에 다 실을 수 없다 (긴 줄은 조용히 삼켜지고 타임아웃난다).
export async function writeFile(run, path, content, chunk = 256) {
    const b64 = Buffer.from(content).toString("base64");
    const dir = path.replace(/\/[^/]*$/, "") || "/";
    let r = await run(`mkdir -p '${dir}' && : > '${path}.b64'`);
    if (r.exit !== 0) return r;
    for (let i = 0; i < b64.length; i += chunk) {
        r = await run(`printf %s '${b64.slice(i, i + chunk)}' >> '${path}.b64'`, 20000);
        if (r.exit !== 0) return r;
    }
    return run(`base64 -d < '${path}.b64' > '${path}' && rm -f '${path}.b64'`);
}

export function report(label, r) {
    const mark = r.timedOut ? "TIMEOUT" : r.exit === 0 ? "PASS" : `FAIL(exit ${r.exit})`;
    console.log(`\n[${mark}] ${label}`);
    if (r.out) console.log(r.out.split("\n").map((l) => "       " + l).join("\n"));
}
