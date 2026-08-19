// 수집된 풀이 기록을 읽기 좋게 뽑는다.
//
//   node stats.mjs             문제별 요약. 손봐야 할 문제가 위로 온다
//   node stats.mjs text-01     그 문제를 사람들이 실제로 어떻게 풀었는지 명령 전체
//
// SQL 을 외울 필요가 없게 하려고 만들었다. D1 콘솔에서 보면 숫자만 나오고
// commands 가 JSON 한 덩어리로 뭉쳐 있어서 "무엇을 시도했나"를 읽을 수 없다.

import { execFileSync } from "node:child_process";

const arg = process.argv[2];

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
               SUM(saw_solution) AS gaveup,
               AVG(hints_used) AS hints,
               AVG(CAST(goals_passed AS REAL) / MAX(goals_total, 1)) AS progress
        FROM attempts GROUP BY problem_id
        ORDER BY (CAST(SUM(CASE WHEN outcome = 'solved' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)) ASC`);

    if (!rows.length) {
        console.log("아직 수집된 기록이 없다.");
        process.exit(0);
    }

    console.log("문제          도전   성공   성공률   평균진척  평균시간  정답봄");
    console.log("─".repeat(66));
    for (const r of rows) {
        // 성공률이 낮은 문제가 곧 고장난 문제다. 눈에 띄게 표시한다.
        const rate = r.solved / r.n;
        const flag = rate < 0.4 ? " ← 손볼 것" : rate < 0.7 ? " ←" : "";
        console.log(
            `${r.problem_id.padEnd(12)} ${String(r.n).padStart(5)}` +
            `  ${String(r.solved).padStart(5)}` +
            `   ${(Math.round(rate * 100) + "%").padStart(5)}` +
            `   ${(Math.round((r.progress ?? 0) * 100) + "%").padStart(7)}` +
            `   ${secs(r.ms).padStart(7)}` +
            `   ${String(r.gaveup).padStart(4)}${flag}`);
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
