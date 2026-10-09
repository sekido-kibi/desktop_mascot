// preload.ts で公開した API
interface MascotApi {
  setIgnoreMouse(ignore: boolean): void;
  dragMove(dx: number, dy: number): void;
  dragEnd(): void;
  walkStep(dx: number): Promise<boolean>;
  walkEnd(): void;
  onSay(cb: (text: string, ms?: number) => void): void;
}
declare const mascot: MascotApi;

type MascotState = "idle" | "click" | "walk" | "jump" | "sleep";

// 状態ごとのアニメーション（画像番号は imgs/mouse_slime_N.png の N）
const ANIMATIONS: Record<MascotState, { frames: number[]; interval: number; loop: boolean }> = {
  idle: { frames: [1, 2], interval: 600, loop: true },
  click: { frames: [5, 3, 1], interval: 120, loop: false },
  // しゃがむ(5) → 伸びて空中(1) → 着地でつぶれる(5)
  walk: { frames: [5, 1, 1, 1, 5], interval: 120, loop: true },
  jump: { frames: [5, 1, 1, 1, 1, 5], interval: 120, loop: false },
  sleep: { frames: [6], interval: 1000, loop: true },
};

const SLEEP_AFTER_MS = 60_000;
const DRAG_THRESHOLD = 3;
const DOUBLE_CLICK_MS = 250;
const BUBBLE_MS = 4000;
const WALK_CHECK_MS = 4000;
const WALK_CHANCE = 0.3;
const JUMP_HEIGHT_PX = 60;
const HOP_HEIGHT_PX = 20;
const WALK_STEP_MS = 50;
const WALK_STEP_PX = 3;
const CLICK_LINES = ["ぷるん", "なあに？", "つつかないで〜", "えへへ", "ぽよん！"];

const sprite = document.getElementById("sprite") as HTMLImageElement;
const bubble = document.getElementById("bubble") as HTMLDivElement;

let state: MascotState = "idle";
let frameIndex = 0;
let frameTimer: number | undefined;
let sleepTimer: number | undefined;
let motion: Animation | undefined;

function setState(next: MascotState) {
  state = next;
  frameIndex = 0;
  window.clearTimeout(frameTimer);
  motion?.cancel();
  if (next === "jump") jump();
  if (next === "walk") hop();
  tick();
}

function tick() {
  const anim = ANIMATIONS[state];
  sprite.src = `../imgs/mouse_slime_${anim.frames[frameIndex]}.png`;
  frameIndex++;
  if (frameIndex >= anim.frames.length) {
    if (!anim.loop) {
      frameTimer = window.setTimeout(() => setState("idle"), anim.interval);
      return;
    }
    frameIndex = 0;
  }
  frameTimer = window.setTimeout(tick, anim.interval);
}

function resetSleepTimer() {
  window.clearTimeout(sleepTimer);
  sleepTimer = window.setTimeout(() => setState("sleep"), SLEEP_AFTER_MS);
}

// ---- 吹き出し ----
let bubbleTimer: number | undefined;

function say(text: string, ms = BUBBLE_MS) {
  bubble.textContent = text;
  bubble.hidden = false;
  window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(hideBubble, ms);
}

function hideBubble() {
  bubble.hidden = true;
  window.clearTimeout(bubbleTimer);
}

bubble.addEventListener("click", hideBubble);

mascot.onSay((text, ms) => {
  if (state === "sleep") setState("idle");
  resetSleepTimer();
  say(text, ms);
});

// ---- ジャンプ：しゃがみの 1 コマ後に飛び上がり、空中 4 コマ分で着地 ----
function jump() {
  const { interval } = ANIMATIONS.jump;
  motion = sprite.animate([
    { transform: "translateY(0)", easing: "ease-out" },
    { transform: `translateY(-${JUMP_HEIGHT_PX}px)`, easing: "ease-in" },
    { transform: "translateY(0)" },
  ], { duration: interval * 4, delay: interval });
}

// ---- 歩き回り：小さく跳ねながら進む ----
// walk アニメ 1 周（しゃがみ 1 コマ・空中 3 コマ・着地 1 コマ）が 1 ホップ
const HOP_MS = ANIMATIONS.walk.frames.length * ANIMATIONS.walk.interval;
const HOP_AIR_START = 1 / 5;
const HOP_AIR_END = 4 / 5;

function hop() {
  motion = sprite.animate([
    { offset: 0, transform: "translateY(0)" },
    { offset: HOP_AIR_START, transform: "translateY(0)", easing: "ease-out" },
    { offset: (HOP_AIR_START + HOP_AIR_END) / 2, transform: `translateY(-${HOP_HEIGHT_PX}px)`, easing: "ease-in" },
    { offset: HOP_AIR_END, transform: "translateY(0)" },
    { offset: 1, transform: "translateY(0)" },
  ], { duration: HOP_MS, iterations: Infinity });
}

let walking = false;

async function walk() {
  walking = true;
  setState("walk");
  const dir = Math.random() < 0.5 ? -1 : 1;
  const start = Date.now();
  // ホップの途中で止まらないよう、回数で終わりを決める
  let hops = 3 + Math.floor(Math.random() * 7);
  while (state === "walk") {
    const elapsed = Date.now() - start;
    if (elapsed >= hops * HOP_MS) break;
    // 横に進むのは空中にいる間だけ。進めなくなったら今のホップで終わり
    const phase = (elapsed % HOP_MS) / HOP_MS;
    if (phase >= HOP_AIR_START && phase < HOP_AIR_END && !(await mascot.walkStep(dir * WALK_STEP_PX))) {
      hops = Math.ceil(elapsed / HOP_MS);
    }
    await new Promise((r) => window.setTimeout(r, WALK_STEP_MS));
  }
  walking = false;
  if (state === "walk") setState("idle");
  mascot.walkEnd();
}

window.setInterval(() => {
  if (state === "idle" && !walking && !dragStart && Math.random() < WALK_CHANCE) void walk();
}, WALK_CHECK_MS);

// ---- クリック透過：キャラと吹き出しの上だけマウスを受け付ける ----
let ignoring = true;

function setIgnore(ignore: boolean) {
  if (ignore === ignoring) return;
  ignoring = ignore;
  mascot.setIgnoreMouse(ignore);
}

document.addEventListener("mousemove", (e) => {
  if (dragStart) return;
  setIgnore(e.target !== sprite && !bubble.contains(e.target as Node));
});
document.addEventListener("mouseleave", () => {
  if (!dragStart) setIgnore(true);
});

// ---- ドラッグで移動、ほぼ動かさずに離したらクリック、2 回続けたらダブルクリック ----
let clickTimer: number | undefined;

function onClick() {
  if (clickTimer !== undefined) {
    // ダブルクリック：保留中のシングルクリックは取り消してジャンプ
    window.clearTimeout(clickTimer);
    clickTimer = undefined;
    setState("jump");
    return;
  }
  clickTimer = window.setTimeout(() => {
    clickTimer = undefined;
    setState("click");
    say(CLICK_LINES[Math.floor(Math.random() * CLICK_LINES.length)]);
  }, DOUBLE_CLICK_MS);
}

let dragStart: { x: number; y: number } | null = null;
let last = { x: 0, y: 0 };
let dragged = false;

sprite.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  sprite.setPointerCapture(e.pointerId);
  dragStart = last = { x: e.screenX, y: e.screenY };
  dragged = false;
});

sprite.addEventListener("pointermove", (e) => {
  if (!dragStart) return;
  if (!dragged && Math.hypot(e.screenX - dragStart.x, e.screenY - dragStart.y) < DRAG_THRESHOLD) return;
  if (!dragged && (state === "walk" || state === "jump")) setState("idle");
  dragged = true;
  mascot.dragMove(e.screenX - last.x, e.screenY - last.y);
  last = { x: e.screenX, y: e.screenY };
});

sprite.addEventListener("pointerup", () => {
  if (!dragStart) return;
  dragStart = null;
  if (dragged) mascot.dragEnd();
  else onClick();
  resetSleepTimer();
});

sprite.addEventListener("dragstart", (e) => e.preventDefault());

setState("idle");
resetSleepTimer();
