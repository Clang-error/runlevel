// 수집된 풀이 기록을 읽기 좋게 뽑는다.
//
//   node stats.mjs             문제별 요약. 사이트에 보이는 순서(레벨 → 문제)로 늘어놓는다
//   node stats.mjs text-01     그 문제를 사람들이 실제로 어떻게 풀었는지 명령 전체
//
// SQL 을 외울 필요가 없게 하려고 만들었다. D1 콘솔에서 보면 숫자만 나오고
// commands 가 JSON 한 덩어리로 뭉쳐 있어서 "무엇을 시도했나"를 읽을 수 없다.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// 사이트에 보이는 순서로 세우려면 각 문제의 레벨이 필요한데, D1 에는 문제 id 밖에 없다.
// problems/ 를 직접 읽어 순서를 만든다. 홈 화면과 같은 규칙이다 —
// 레벨이 먼저이고, 같은 레벨 안에서는 파일을 훑은 순서(디렉터리 이름 순)를 따른다.
// js-yaml 을 끌어오지 않고 맨 앞의 두 줄만 본다. id 와 level 은 항상 단순한 값이다.
const ORDER = (() => {
    const root = path.join(import.meta.dirname, "..", "problems");
    const map = new Map();
    let i = 0;
    for (const dir of fs.readdirSync(root).sort()) {
        const full = path.join(root, dir);
        if (!fs.statSync(full).isDirectory()) continue;
        for (const f of fs.readdirSync(full).sort()) {
            if (!f.endsWith(".yaml")) continue;
            const raw = fs.readFileSync(path.join(full, f), "utf8");
            const id = raw.match(/^id:\s*(\S+)/m)?.[1];
            const level = Number(raw.match(/^level:\s*(\d+)/m)?.[1] ?? 9);
            if (id) map.set(id, { level, seq: i++ });
        }
    }
    return map;
})();

// 문제 파일이 사라졌는데 기록만 남은 경우가 있을 수 있다. 그런 것은 맨 뒤로 보낸다.
const place = (id) => ORDER.get(id) ?? { level: 9, seq: 1e9 };

const arg = process.argv[2];

// 이 미만이면 성공률을 신호로 읽지 않는다.
//
// 1명이 실패하면 그대로 0% 가 된다. 거기에 "손볼 것" 을 달면 새 문제를 낼 때마다
// 첫 도전자가 실패했다는 이유로 빨간 깃발이 뜨고, 멀쩡한 문제를 고치러 들어가게 된다.
// (awk-04 가 도전 1명·실패 1명으로 실제로 그렇게 잡혔다.)
// 공개 API(/api/stats)도 같은 값으로 표본 미달 문제를 아예 안 내보낸다 — 두 곳이 같아야 한다.
const MIN_SAMPLE = 5;

// wrangler 가 실패하면 Node 스택 트레이스가 쏟아져서 진짜 원인이 파묻힌다.
// 무엇이 잘못됐고 무엇을 하면 되는지만 남긴다.
function fail(msg, hints) {
    console.error(`\n${msg}\n`);
    for (const h of hints) console.error(`  · ${h}`);
    console.error();
    process.exit(1);
}

function query(sql) {
    let out;
    try {
        out = execFileSync("npx", [
            "wrangler", "d1", "execute", "runlevel-stats", "--remote", "--json", "--command", sql,
        ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
        const text = `${e.stdout ?? ""}${e.stderr ?? ""}`;
        const code = text.match(/"code":\s*(\d+)/)?.[1];

        if (code === "7403" || /not authorized/i.test(text)) {
            const envVars = Object.keys(process.env)
                .filter((k) => /^(CLOUDFLARE|CF)_/.test(k) && k !== "CF_USER_TEXT_ENCODING");
            fail("Cloudflare 가 이 계정으로는 D1 을 못 읽게 막았다 (7403).", [
                envVars.length
                    ? `셸에 ${envVars.join(", ")} 가 설정돼 있다. 이게 로그인 정보를 덮어쓴다 — 지우고 다시 실행: unset ${envVars.join(" ")}`
                    : "셸에 CLOUDFLARE_* 환경변수가 있는지 확인: env | grep CLOUDFLARE",
                "로그인이 만료됐을 수 있다: npx wrangler login",
                "계정이 여러 개면 다른 계정을 보고 있을 수 있다: npx wrangler whoami",
            ]);
        }
        if (/ENOENT/.test(text) || /command not found/i.test(text)) {
            fail("wrangler 를 실행하지 못했다.", ["api/ 디렉터리에서 실행해야 한다: cd api && node stats.mjs"]);
        }
        fail("wrangler d1 execute 가 실패했다.", [text.trim().split("\n").slice(-6).join("\n    ")]);
    }
    // wrangler 가 앞에 배너를 찍는 경우가 있어 JSON 시작점부터 자른다
    const start = out.indexOf("[");
    if (start < 0) fail("wrangler 응답에서 JSON 을 못 찾았다.", [out.trim().slice(0, 300)]);
    return JSON.parse(out.slice(start))[0].results;
}

const secs = (ms) => (ms / 1000).toFixed(0) + "s";

if (!arg) {
    const rows = query(`
        SELECT problem_id,
               COUNT(*) AS n,
               SUM(CASE WHEN outcome = 'solved' THEN 1 ELSE 0 END) AS solved,
               -- 2026-08-19 이전 행은 "문제를 연 시각"부터, 이후 행은 "첫 명령을 친 시각"부터다.
               -- 옛 행에는 읽는 시간과 자리 비운 시간이 섞여 있어 훨씬 크다. 섞인 평균은
               -- 그만큼 부풀어 있으니, 이 값으로 난이도를 판단하려면 옛 행이 밀려날 때까지 기다린다.
               AVG(elapsed_ms) AS ms,
               -- 정답을 본 것을 한 덩어리로 세면 안 된다. 보고 그만둔 사람과
               -- 보고 이해해서 푼 사람이 섞이는데, 뒤쪽은 포기가 아니라 학습이다.
               -- 문제를 손볼지 판단할 때 이 둘이 뭉개져 있으면 잘못 짚는다.
               --
               -- 푼 뒤에 정답을 본 경우는 애초에 여기 안 잡힌다. 성공은 통과하는 즉시
               -- 보내고 한 방문에 한 건만 보내므로, 그 뒤에 정답을 봐도 이미 나간
               -- 기록은 saw_solution = 0 이다.
               SUM(CASE WHEN saw_solution = 1 AND outcome = 'solved' THEN 1 ELSE 0 END) AS sawSolved,
               SUM(CASE WHEN saw_solution = 1 AND outcome <> 'solved' THEN 1 ELSE 0 END) AS sawLeft,
               AVG(hints_used) AS hints,
               AVG(CAST(goals_passed AS REAL) / MAX(goals_total, 1)) AS progress
        FROM attempts GROUP BY problem_id`);

    // 정렬은 SQL 이 아니라 여기서 한다. 레벨은 D1 이 모르는 값이라 문제 파일에서 왔다.
    rows.sort((a, b) => {
        const x = place(a.problem_id), y = place(b.problem_id);
        return x.level - y.level || x.seq - y.seq;
    });

    if (!rows.length) {
        console.log("아직 수집된 기록이 없다.");
        process.exit(0);
    }

    console.log("Lv  문제          도전   성공   성공률   평균진척  평균시간   정답봄(풀었음/그만둠)");
    console.log("─".repeat(82));
    let lastLevel = null;
    for (const r of rows) {
        // 레벨이 바뀌는 자리에 빈 줄을 넣는다. 72줄이 한 덩어리면 경계가 안 보인다.
        const lv = place(r.problem_id).level;
        if (lastLevel !== null && lv !== lastLevel) console.log("");
        lastLevel = lv;
        // 성공률이 낮은 문제가 곧 고장난 문제다. 눈에 띄게 표시한다.
        // 단 표본이 안 차면 성공률 자체가 신호가 아니므로 깃발을 달지 않는다.
        const rate = r.solved / r.n;
        const flag = r.n < MIN_SAMPLE ? "  (표본 부족)"
            : rate < 0.4 ? " ← 손볼 것"
            : rate < 0.7 ? " ←"
            : "";
        console.log(
            `${String(lv).padEnd(3)} ${r.problem_id.padEnd(12)} ${String(r.n).padStart(5)}` +
            `  ${String(r.solved).padStart(5)}` +
            `   ${(Math.round(rate * 100) + "%").padStart(5)}` +
            `   ${(Math.round((r.progress ?? 0) * 100) + "%").padStart(7)}` +
            `   ${secs(r.ms).padStart(7)}` +
            `   ${`${r.sawSolved}/${r.sawLeft}`.padStart(9)}${flag}`);
    }
    console.log(`\n총 ${rows.reduce((a, r) => a + r.n, 0)}건`);
    console.log("한 문제를 자세히 보려면:  node stats.mjs <문제id>");
    process.exit(0);
}

// --- 문제 하나를 깊이 본다 ---
const rows = query(
    `SELECT at, commands, outcome, elapsed_ms, hints_used, saw_solution, goals_passed, goals_total
     FROM attempts WHERE problem_id = '${arg.replace(/'/g, "")}' ORDER BY id DESC LIMIT 50`);

if (!rows.length) {
    console.log(`${arg} 기록이 없다.`);
    process.exit(0);
}

console.log(`${arg} — ${rows.length}건 (최근 것부터)\n`);
for (const r of rows) {
    const tags = [
        r.outcome === "solved" ? "통과" : r.outcome === "left" ? `중단 (${r.goals_passed}/${r.goals_total})` : `이탈 (${r.goals_passed}/${r.goals_total})`,
        secs(r.elapsed_ms),
        r.hints_used ? `힌트 ${r.hints_used}개` : null,
        r.saw_solution ? "정답 봄" : null,
    ].filter(Boolean).join(" · ");
    console.log(`[${r.at.slice(0, 16).replace("T", " ")}]  ${tags}`);
    for (const c of JSON.parse(r.commands)) console.log(`    $ ${c}`);
    console.log();
}
