// 환경설정. localStorage 에만 저장하고 CSS 변수로 적용한다.
//
// 라이브러리를 쓰지 않는다. 테마는 :root 의 CSS 변수를 갈아끼우는 것뿐이고,
// 터미널은 xterm 의 옵션 두 개(fontSize, theme)만 건드린다.
// 화면 전환 때 VM 은 전혀 관여하지 않으므로 비용이 없다.

const KEY = "dotslash.settings.v1";

export const DEFAULTS = {
    fontSize: 13,
    termColor: "default",   // 터미널 글자 색
    appTheme: "dark",       // 화면 밝기
    // 힌트·정답 버튼을 아예 숨길 수 있게 한다.
    // 눈앞에 있으면 막히기 전에 먼저 누르게 된다 — 숨겨두면 그 유혹이 사라진다.
    showHints: true,
    showSolution: true,
    // 푼 문제의 풀이 기록을 보낼지. 문제를 고치는 데 쓸 데이터라 기본은 켬이고,
    // 무엇을 보내는지는 설정 화면에 그대로 적어둔다. 끄면 아무것도 나가지 않는다.
    sendStats: true,
};

// 터미널 글자 색 프리셋. 배경은 화면 테마를 따라간다.
export const TERM_COLORS = {
    default: { label: "기본", dark: "#d8dee9", light: "#2e3440" },
    green: { label: "초록", dark: "#8ae234", light: "#2a6b0a" },
    amber: { label: "주황", dark: "#ffb454", light: "#8a4b00" },
    white: { label: "흰색", dark: "#ffffff", light: "#000000" },
};

// 화면 테마. 값이 그대로 CSS 변수가 된다.
const THEMES = {
    dark: {
        bg: "#16181d", panel: "#1b1e24", line: "#2b2f38",
        fg: "#d8dee9", dim: "#6b7280", accent: "#88c0d0",
        ok: "#a3be8c", no: "#bf616a", warn: "#ebcb8b",
    },
    light: {
        bg: "#f7f8fa", panel: "#ffffff", line: "#d8dce3",
        fg: "#2e3440", dim: "#6b7280", accent: "#2b7a8c",
        ok: "#3f7d20", no: "#b03a2e", warn: "#8a6a00",
    },
};

export function load() {
    try {
        const raw = localStorage.getItem(KEY);
        return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    } catch {
        return { ...DEFAULTS };
    }
}

export function save(s) {
    try {
        localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
        // 저장이 안 돼도 이번 세션에서는 그대로 적용된다
    }
}

// 설정을 화면에 반영한다. term 이 아직 없으면 화면 테마만 적용한다.
export function apply(s, { term, onTermResize } = {}) {
    const t = THEMES[s.appTheme] ?? THEMES.dark;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(t)) root.style.setProperty(`--${k}`, v);

    if (!term) return;
    const color = TERM_COLORS[s.termColor] ?? TERM_COLORS.default;
    term.options.fontSize = s.fontSize;
    term.options.theme = {
        background: t.bg,
        foreground: color[s.appTheme] ?? color.dark,
        cursor: color[s.appTheme] ?? color.dark,
    };
    onTermResize?.();      // 글자 크기가 바뀌면 열/행 수가 달라진다
}
