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

type MascotState = "idle" | "click" | "walk" | "sleep";

// 状態ごとのアニメーション（画像番号は imgs/mouse_slime_N.png の N）
const ANIMATIONS: Record<MascotState, { frames: number[]; interval: number; loop: boolean }> = {
  idle: { frames: [1, 2], interval: 600, loop: true },
  click: { frames: [5, 3, 1], interval: 120, loop: false },
  walk: { frames: [1, 4], interval: 250, loop: true },
  sleep: { frames: [6], interval: 1000, loop: true },
};

const SLEEP_AFTER_MS = 60_000;
const DRAG_THRESHOLD = 3;
const BUBBLE_MS = 4000;
const WALK_CHECK_MS = 4000;
const WALK_CHANCE = 0.3;
const WALK_STEP_MS = 50;
const WALK_STEP_PX = 2;
const CLICK_LINES = ["ぷるん", "なあに？", "つつかないで〜", "えへへ", "ぽよん！"];

const sprite = document.getElementById("sprite") as HTMLImageElement;
const bubble = document.getElementById("bubble") as HTMLDivElement;

let state: MascotState = "idle";
let frameIndex = 0;
let frameTimer: number | undefined;
let sleepTimer: number | undefined;

function setState(next: MascotState) {
  state = next;
  frameIndex = 0;
  window.clearTimeout(frameTimer);
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

// ---- 歩き回り ----
let walking = false;

async function walk() {
  walking = true;
  setState("walk");
  const dir = Math.random() < 0.5 ? -1 : 1;
  const until = Date.now() + 2000 + Math.random() * 4000;
  while (state === "walk" && Date.now() < until) {
    if (!(await mascot.walkStep(dir * WALK_STEP_PX))) break;
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

// ---- ドラッグで移動、ほぼ動かさずに離したらクリック扱い ----
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
  if (!dragged && state === "walk") setState("idle");
  dragged = true;
  mascot.dragMove(e.screenX - last.x, e.screenY - last.y);
  last = { x: e.screenX, y: e.screenY };
});

sprite.addEventListener("pointerup", () => {
  if (!dragStart) return;
  dragStart = null;
  if (dragged) {
    mascot.dragEnd();
  } else {
    setState("click");
    say(CLICK_LINES[Math.floor(Math.random() * CLICK_LINES.length)]);
  }
  resetSleepTimer();
});

sprite.addEventListener("dragstart", (e) => e.preventDefault());

setState("idle");
resetSleepTimer();
