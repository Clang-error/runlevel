// 사용자가 보낸 신고를 읽는다.
//
//   node reports.mjs           최근 신고 목록 (본문까지, 로그는 유무만)
//   node reports.mjs 12        12번 신고의 터미널 기록 전체
//   node reports.mjs --new     아직 안 본 것만 (.reports-seen 이후)
//
// stats.mjs 가 "어디서 막혔는가"를 보여준다면 이건 "무엇이 이상하다고 느꼈는가"다.
// 둘을 같이 봐야 한다 — 통계는 증상이고 신고는 증언이다.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const here = import.meta.dirname;
const SEEN = path.join(here, ".reports-seen");   // 마지막으로 확인한 id
const arg = process.argv[2];

function fail(msg, hints) {
    console.error(`\n${msg}\n`);
    for (const h of hints) console.error(`  · ${h}`);
    console.error();
    process.exit(1);
}

// stats.mjs 와 같은 방식. wrangler 실패를 읽을 수 있게 바꿔준다.
function query(sql) {
    let out;
    try {
        out = execFileSync("npx", [
            "wrangler", "d1", "execute", "runlevel-stats", "--remote", "--json", "--command", sql,
        ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
        const text = `${e.stdout ?? ""}${e.stderr ?? ""}`;
        if (/"code":\s*7403/.test(text) || /not authorized/i.test(text)) {
            const envVars = Object.keys(process.env)
                .filter((k) => /^(CLOUDFLARE|CF)_/.test(k) && k !== "CF_USER_TEXT_ENCODING");
            fail("Cloudflare 가 이 계정으로는 D1 을 못 읽게 막았다 (7403).", [
                envVars.length
                    ? `셸의 ${envVars.join(", ")} 가 로그인 정보를 덮어쓴다: unset ${envVars.join(" ")}`
                    : "env | grep CLOUDFLARE 로 확인",
                "로그인 만료일 수 있다: npx wrangler login",
            ]);
        }
        if (/ENOENT/.test(text) || /command not found/i.test(text)) {
            fail("wrangler 를 실행하지 못했다.", ["api/ 에서 실행해야 한다: cd api && node reports.mjs"]);
        }
        fail("wrangler d1 execute 가 실패했다.", [text.trim().split("\n").slice(-6).join("\n    ")]);
    }
    const start = out.indexOf("[");
    if (start < 0) fail("wrangler 응답에서 JSON 을 못 찾았다.", [out.trim().slice(0, 300)]);
    return JSON.parse(out.slice(start))[0].results;
}

const esc = (s) => String(s).replace(/'/g, "''");
const when = (iso) => iso.replace("T", " ").slice(5, 16);
const where = (r) =>
    r.kind === "problem" ? `문제 ${r.target}`
    : r.kind === "command" ? `명령어 ${r.target}`
    : r.kind === "free" ? "자유 터미널"
    : "홈";

// --- 신고 하나를 통째로 보기 ---
if (arg && /^\d+$/.test(arg)) {
    const [r] = query(`SELECT * FROM reports WHERE id = ${Number(arg)}`);
    if (!r) fail(`${arg}번 신고가 없다.`, ["목록을 먼저 보라: node reports.mjs"]);

    console.log(`\n#${r.id}  ${when(r.at)}  ${where(r)}\n`);
    console.log(r.message.split("\n").map((l) => "  " + l).join("\n"));
    if (!r.log) {
        console.log("\n(터미널 기록을 함께 보내지 않았다)\n");
    } else {
        console.log(`\n─── 터미널 기록 (${(r.log.length / 1024).toFixed(1)}KB) ───\n`);
        // 게스트가 뱉은 제어문자를 그대로 찍으면 보는 쪽 터미널이 망가진다.
        // 색만 지우고 나머지 제어문자는 눈에 보이게 바꾼다.
        console.log(r.log
            .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
            .replace(/\r/g, "")
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "·"));
    }
    process.exit(0);
}

// --- 목록 ---
let sinceId = 0;
if (arg === "--new") {
    try { sinceId = Number(fs.readFileSync(SEEN, "utf8").trim()) || 0; } catch { /* 처음 */ }
}
const rows = query(
    `SELECT id, at, kind, target, message, LENGTH(log) AS logsize
     FROM reports WHERE id > ${sinceId} ORDER BY id DESC LIMIT 50`);

if (!rows.length) {
    console.log(sinceId ? `${sinceId}번 이후 새 신고가 없다.` : "아직 신고가 없다.");
    process.exit(0);
}

console.log();
for (const r of rows.reverse()) {
    const log = r.logsize ? `기록 ${(r.logsize / 1024).toFixed(1)}KB` : "기록 없음";
    console.log(`#${String(r.id).padStart(3)}  ${when(r.at)}  ${where(r)}  · ${log}`);
    for (const line of r.message.split("\n")) console.log(`      ${line}`);
    console.log();
}

const newest = Math.max(...rows.map((r) => r.id));
console.log(`${rows.length}건${sinceId ? " (새 신고만)" : ""}`);
console.log(`터미널 기록을 보려면:  node reports.mjs <번호>`);

// 여기까지 봤다고 표시해 둔다. --new 로 다음부터 새것만 볼 수 있다.
try { fs.writeFileSync(SEEN, String(newest)); } catch { /* 무시 */ }
