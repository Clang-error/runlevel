// 문제 파일 정적 검사. VM 을 띄우지 않아 즉시 끝난다.
//
// test-problems.mjs 는 실제로 풀어보며 검증하지만 30초쯤 걸린다.
// 문제를 쓰는 중에는 이 린트로 먼저 걸러내는 편이 빠르다.
//
// 실행: node lint-problems.mjs

import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..", "problems");
const yaml = await import(path.join(import.meta.dirname, "..", "web", "node_modules", "js-yaml", "dist", "js-yaml.mjs"));

// 채점 조건은 읽기만 해야 한다. 상태를 바꾸면 다음 판정이 오염된다.
const MUTATING = /\b(rm|mv|cp|touch|mkdir|chmod|chown|chgrp|dd|mkfs\.\w+|tee|sed -i)\b/;
// 예외: /tmp 안에서 매번 지우고 다시 만드는 멱등 검사.
// 스크립트를 "실행해서" 채점하려면 결과를 쓸 곳이 필요하다.
const IDEMPOTENT_TMP = /^\s*rm -rf \/tmp\/\S+ &&/;
// 부정 조건은 대상이 없으면 공허하게 참이 된다.
// 다만 setup 이 이미 만들어 둔 파일이면 문제가 없다.
// 사용자가 새로 만들어야 하는 작업 영역 경로에 대해서만 따진다.
const NEGATION = /(^|\s)!\s|\bgrep -qv\b/;
const EXISTENCE = /\[\s*-[sfdbe]\s|test -[sfdbe]\s/;
const WORKPATH = /\/(?:work|data|backup)\/[\w./-]+/g;

const issues = [];
const add = (f, m) => issues.push(`${f.padEnd(16)} ${m}`);
const ids = new Set();
let count = 0;

for (const dir of fs.readdirSync(ROOT)) {
    const full = path.join(ROOT, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full).filter((x) => x.endsWith(".yaml")).sort()) {
        let p;
        try {
            p = yaml.load(fs.readFileSync(path.join(full, file), "utf8"));
        } catch (e) {
            add(file, `YAML 오류: ${e.message.split("\n")[0]}`);
            continue;
        }
        count++;

        // chown 은 SUID·SGID 를 지운다 (POSIX).
        //
        // setup 이 특수 비트를 붙여놓으면 applySetup 의 자동 chown 이 그걸 날려서,
        // 문제를 열자마자 목표가 이미 통과한 상태가 된다.
        // sudo-03 과 sudo-04 가 실제로 그렇게 깨졌고, 두 번 다 51문제를 전부
        // 돌리고 나서야 알았다. 여기서 미리 잡는다.
        {
            const st = p.setup ?? {};
            const script = String(st.script ?? "");
            const special = /chmod\s+[1-7][0-7]{3}\b/.test(script) || /chmod\s+[ugo]*[+-]s\b/.test(script);
            if (special && !st.keepOwner && (st.user ?? "student") !== "root")
                add(file, "setup 이 특수 비트(SUID/SGID/sticky)를 붙이는데 keepOwner 가 없다 — chown 이 그 비트를 지운다");
        }

        // 글로 쓰는 칸은 반드시 문자열이어야 한다.
        //
        // YAML 의 따옴표 없는 값에 ": "(콜론+공백)가 들어가면 문자열이 아니라 매핑이 된다.
        // 파싱은 조용히 성공하고 화면에만 "[object Object]" 가 찍힌다.
        // (sudo-02 의 힌트 "... 옵션: 명령 ..." 가 실제로 그랬다.)
        const mustBeText = [
            ["prompt", p.prompt], ["given", p.given], ["solution", p.solution],
            ...(p.hints ?? []).map((h, i) => [`hints[${i}]`, h]),
            ...[...(p.check ?? []), ...(p.guard ?? [])].flatMap((c, i) => [
                [`조건[${i}].desc`, c?.desc], [`조건[${i}].cmd`, c?.cmd],
            ]),
        ];
        for (const [where, v] of mustBeText) {
            if (v !== undefined && typeof v !== "string")
                add(file, `${where} 가 문자열이 아니다 — ": " 가 들어갔으면 따옴표로 감쌀 것`);
        }

        if (!p.id) add(file, "id 없음");
        else if (`${p.id}.yaml` !== file) add(file, `파일명과 id 불일치 (${p.id})`);
        if (ids.has(p.id)) add(file, "id 중복");
        ids.add(p.id);
        if (!p.category) add(file, "category 없음");
        if (!(p.level >= 1 && p.level <= 5)) add(file, `level 이 1~5 가 아님 (${p.level})`);
        if (!p.prompt?.trim()) add(file, "prompt 없음");

        if (p.type === "quiz") {
            if (!p.answer) add(file, "quiz 인데 answer 없음");
            continue;
        }

        if (!p.check?.length) add(file, "check 없음");
        if (!p.solution?.trim()) add(file, "solution 없음 — 자동 검증에서 빠진다");
        if (!p.hints?.length) add(file, "hints 없음");
        if (p.setup?.disks && p.setup.disks.some((d) => d.dev !== "/dev/sdb"))
            add(file, "스크래치 디스크는 /dev/sdb 하나뿐이다");

        // 문제 계정이 root 가 아닌데 고쳐야 할 파일을 script 로 만들면 소유자가 root 로 남아
        // 사용자가 손댈 수 없다. script 안에서 chown 을 해줬다면 괜찮다.
        const script = p.setup?.script ?? "";
        // /work 바깥(예: /root)에 일부러 root 소유 파일을 두는 문제도 있으므로
        // 작업 영역에 파일을 만드는 경우만 따진다.
        if (p.setup?.user && p.setup.user !== "root" && /\/work\//.test(script)
            && !p.setup?.files && !/chown/.test(script))
            add(file, `user: ${p.setup.user} 인데 파일을 script 로만 만들고 chown 도 없다`);

        for (const c of [...(p.check ?? []), ...(p.guard ?? [])]) {
            if (!c.desc) add(file, "desc 없는 조건");
            if (!c.cmd) { add(file, "cmd 없는 조건"); continue; }
            if (MUTATING.test(c.cmd) && !IDEMPOTENT_TMP.test(c.cmd))
                add(file, `채점 조건이 상태를 바꾼다: ${c.cmd.slice(0, 50)}`);
            if (NEGATION.test(c.cmd) && !EXISTENCE.test(c.cmd)) {
                // setup 이 만들어 두지 않은 작업 파일을 부정 조건으로 보는 경우만 위험하다
                const setupText = JSON.stringify(p.setup ?? {});
                const risky = (c.cmd.match(WORKPATH) ?? []).filter((f) => !setupText.includes(f));
                if (risky.length)
                    add(file, `부정 조건인데 ${risky[0]} 가 없을 때도 통과한다: ${c.cmd.slice(0, 45)}`);
            }
        }
    }
}

console.log(issues.length ? issues.map((i) => "  " + i).join("\n") : "  지적 사항 없음");
console.log(`\n문제 ${count}개 검사`);
process.exit(issues.length ? 1 : 0);
