// 문제 전수 회귀 테스트 (Node). 브라우저 없이 돌고 진행 상황을 실시간으로 찍는다.
//
// 문제마다:  setup 적용 -> 채점(실패해야 함) -> solution 실행 -> 채점(통과해야 함)
// solution 은 장식이 아니라 테스트 픽스처다.
//
// 실행: node test-problems.mjs [문제ID]

import fs from "node:fs";
import path from "node:path";
import { boot, img } from "./harness.mjs";

const ROOT = path.join(import.meta.dirname, "..", "problems");
const SCRATCH_MB = 64;   // web/vm.js 와 같아야 한다

// 스크래치 디스크를 처음 상태로 되돌린다 (web/problems.js 와 동일한 절차)
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

const RESET_DISK = [
    'SCRATCH=/dev/sdb',
    // 루트가 올라온 디스크와 같으면 중단한다
    'ROOTDISK=$(findmnt -no SOURCE / | sed "s/[0-9]*$//")',
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
const only = process.argv[2];

// 아주 작은 YAML 파서 대신 js-yaml 을 쓴다 (web/ 에 이미 설치돼 있다)
const yaml = await import(path.join(import.meta.dirname, "..", "web", "node_modules", "js-yaml", "dist", "js-yaml.mjs"));

const files = [];
for (const dir of fs.readdirSync(ROOT)) {
    const full = path.join(ROOT, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full).sort()) if (f.endsWith(".yaml")) files.push(path.join(full, f));
}
// 파일 하나가 깨져도 나머지는 검사할 수 있어야 한다
let problems = [];
for (const f of files) {
    try {
        problems.push(yaml.load(fs.readFileSync(f, "utf8")));
    } catch (e) {
        console.log(`  FAIL  ${path.basename(f)} — YAML 오류: ${e.message.split("\n")[0]}`);
        problems.push({ id: path.basename(f, ".yaml"), __broken: true });
    }
}
problems.sort((a, b) => (a.level - b.level) || a.id.localeCompare(b.id));
if (only) problems = problems.filter((p) => p.id === only);

console.log(`문제 ${problems.length}개, 부팅 중...`);
const vm = await boot({
    memory_size: 128 * 1024 * 1024,
    bzimage: img("images/boot/vmlinuz-lts"),
    initrd: img("images/boot/initramfs-min"),
    hda: img("images/dotslash-64.img"),
    hdb: { buffer: new ArrayBuffer(SCRATCH_MB * 1024 * 1024) },   // T2 스크래치 디스크
    // scsi_mod.scan=sync — initramfs 가 디스크 이름(sda/sdb)을 확정하려면
    // 그 시점에 SCSI 장치 목록이 완성돼 있어야 한다 (make-initramfs.mjs 참고).
    cmdline: "console=ttyS0 root=/dev/sda1 rootfstype=ext4 rw scsi_mod.scan=sync init=/sbin/runlevel-init",
}, { logPath: "serial-problems.log", bootTimeout: 300000 });
console.log(`부팅 완료 (${process.uptime().toFixed(1)}s)\n`);

const writeFileCmd = (p, content) =>
    `mkdir -p '${p.replace(/\/[^/]*$/, "")}' && printf '%s' '${Buffer.from(content).toString("base64")}' | base64 -d > '${p}'`;

async function applySetup(p) {
    const s = p.setup ?? {};
    const user = s.user ?? "student";   // web/problems.js 와 같아야 한다
    await vm.run(RESET_ENV, 30000);
    // web/problems.js 와 같아야 한다
    if (s.sudo) await vm.run("echo 'student ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers");
    await vm.run("rm -rf /work/* /work/.[!.]* 2>/dev/null; mkdir -p /work");
    await vm.run(RESET_DISK, 60000);
    for (const [fp, content] of Object.entries(s.files ?? {})) {
        const r = await vm.run(writeFileCmd(fp, content));
        if (r.exit !== 0) throw new Error(`파일 생성 실패 ${fp}: ${r.out}`);
    }
    if (s.script) {
        // web/problems.js 와 같아야 한다. set -e 없이는 중간이 실패해도 exit 0 이 된다.
        const r = await vm.run(`(\nset -e\n${s.script}\n)`, 60000);
        if (r.exit !== 0) throw new Error(`setup 스크립트 exit ${r.exit}: ${r.out}`);
    }
    // web/problems.js 와 같아야 한다. setup 은 root 로 도니 만들어진 파일이 root 소유다.
    // keepOwner 는 소유권 자체가 문제인 경우의 탈출구.
    if (user !== "root" && !s.keepOwner) {
        await vm.run(`chown -R ${user} /work 2>/dev/null; true`, 30000);
    } else if (user !== "root") {
        const paths = Object.keys(s.files ?? {}).map((f) => `'${f}'`).join(" ");
        await vm.run(`chown ${user} /work ${paths} 2>/dev/null; true`);
    }
    return user;
}

async function runAll(list) {
    const out = [];
    for (const c of list ?? []) {
        const r = await vm.run(c.cmd, 20000);
        out.push({ desc: c.desc, ok: r.exit === 0, timedOut: !!r.timedOut, out: r.out });
    }
    return out;
}
const gradeAll = async (p) => ({ goals: await runAll(p.check), guards: await runAll(p.guard) });

// 아직 지원 안 하는 기능을 요구하는 문제는 건너뛴다
const unsupported = (p) =>
    p.__broken ? null :
    p.type === "quiz" ? "quiz 타입" :
    !p.solution ? "solution 없음" :
    null;

let pass = 0, fail = 0, skip = 0;
for (const p of problems) {
    const why = unsupported(p);
    if (why) { console.log(`  SKIP  ${p.id} (${why})`); skip++; continue; }
    const t = Date.now();
    process.stdout.write(`  ....  ${p.id}`);
    let line;
    try {
        if (p.__broken) throw new Error("YAML 을 읽지 못했다");
        const user = await applySetup(p);
        const before = await gradeAll(p);

        // 목표는 풀기 전에 전부 실패해야 하고, 전제는 전부 성립해야 한다.
        // 이 규칙이 있어야 "처음부터 ✓ 인 조건"이 섞여드는 걸 막는다.
        const earlyPass = before.goals.filter((r) => r.ok).map((r) => r.desc);
        const badGuard = before.guards.filter((r) => !r.ok).map((r) => r.desc);
        if (earlyPass.length) {
            line = `FAIL  ${p.id} — setup 직후 이미 통과하는 목표: ${earlyPass.join(" / ")} (guard 로 옮길 것)`;
        } else if (badGuard.length) {
            line = `FAIL  ${p.id} — setup 직후 깨진 전제: ${badGuard.join(" / ")}`;
        } else {
            // solution 은 문제가 지정한 계정으로, cwd 기준으로 실행한다.
            // 계정을 안 맞추면 root 가 권한을 우회해 권한 문제가 무의미해진다.
            const cwd = p.setup?.cwd ?? "/work";
            const body = `cd '${cwd}' && { ${p.solution.trim()}\n}`;
            const r = user === "root"
                ? await vm.run(body, 60000)
                : await vm.run(`su -s /bin/bash ${user} -c "$(printf %s '${Buffer.from(body).toString("base64")}' | base64 -d)"`, 60000);
            const after = await gradeAll(p);
            const bad = [
                ...after.goals.filter((x) => !x.ok).map((x) => x.desc),
                ...after.guards.filter((x) => !x.ok).map((x) => `전제 깨짐: ${x.desc}`),
            ];

            // 같은 상태에서 여러 번 채점했을 때 결과가 흔들리면 안 된다.
            // 사용자는 명령을 칠 때마다 채점을 받으므로, 흔들리는 조건은
            // 아무것도 안 했는데 갑자기 실패로 뜨는 것처럼 보인다.
            let flaky = null;
            for (let i = 0; i < 3 && !flaky && !bad.length; i++) {
                const again = await gradeAll(p);
                const same = (x, y) => x.length === y.length && x.every((v, k) => v.ok === y[k].ok);
                if (!same(after.goals, again.goals) || !same(after.guards, again.guards)) {
                    flaky = [...again.goals, ...again.guards]
                        .filter((v, k) => v.ok !== [...after.goals, ...after.guards][k].ok)
                        .map((v) => v.desc).join(" / ");
                }
            }

            line = flaky ? `FAIL  ${p.id} — 채점이 흔들린다: ${flaky}`
                : bad.length === 0
                ? `PASS  ${p.id}  (목표 ${after.goals.length} + 전제 ${after.guards.length}, ${((Date.now() - t) / 1000).toFixed(1)}s)`
                : `FAIL  ${p.id} — ${bad.join(" / ")}${r.exit !== 0 ? ` [solution exit ${r.exit}: ${r.out}]` : ""}`;
        }
    } catch (e) {
        line = `FAIL  ${p.id} — ${e.message}`;
    }
    line.startsWith("PASS") ? pass++ : fail++;
    process.stdout.write(`\r  ${line}\n`);
}

console.log(`\n${pass} 통과 / ${fail} 실패 / ${skip} 건너뜀`);
process.exit(fail ? 1 : 0);
