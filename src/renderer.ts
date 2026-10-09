// preload.ts で公開した API
interface MascotApi {
  setIgnoreMouse(ignore: boolean): void;
  dragMove(dx: number, dy: number): void;
  dragEnd(): void;
  walkStep(dx: number): Promise<boolean>;
  walkEnd(): void;
  onSay(cb: (text: string, ms?: number, sound?: "alarm" | "soft") => void): void;
  onStopSound(cb: () => void): void;
}
declare const mascot: MascotApi;

type MascotState = "idle" | "click" | "walk" | "pose" | "sway" | "sleep";

// 状態ごとのアニメーション（画像番号は imgs/mouse_slime_N.png の N）
const ANIMATIONS: Record<MascotState, { frames: number[]; interval: number; loop: boolean }> = {
  idle: { frames: [1], interval: 1000, loop: true },
  click: { frames: [5, 3, 1], interval: 120, loop: false },
  // 1 周 = 1 ホップ（地上 1 コマ・空中 3 コマ・地上 1 コマ）。上下移動は hop() で付ける
  walk: { frames: [1, 1, 1, 1, 1], interval: 120, loop: true },
  // 画像2を 3 秒表示して戻る
  pose: { frames: [2], interval: 3000, loop: false },
  // 画像4で 5 秒間左右に揺れて戻る。揺れは sway() で付ける
  sway: { frames: [4], interval: 5000, loop: false },
  sleep: { frames: [6], interval: 1000, loop: true },
};

const SLEEP_AFTER_MS = 60_000;
const DRAG_THRESHOLD = 3;
const BUBBLE_MS = 4000;
const ACTION_CHECK_MS = 4000;
const ACTION_CHANCE = 0.3;
const HOP_HEIGHT_PX = 20;
const SWAY_DEG = 10;
const SWAY_PERIOD_MS = 1000;
const WALK_STEP_MS = 50;
const WALK_STEP_PX = 3;
const ALARM_REPEAT_MS = 1000;
const ALARM_MAX_MS = 60_000;
const SOUND_GAIN = 0.3; // 音量は PC の音量設定に任せ、アプリ側では固定
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
  if (next === "walk") hop();
  if (next === "sway") sway();
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

// ---- 通知音（Web Audio で生成） ----
let audio: AudioContext | undefined;
let alarmTimer: number | undefined;
let alarmStopTimer: number | undefined;

function tone(freq: number, start: number, duration: number) {
  audio ??= new AudioContext();
  const t = audio.currentTime + start;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = freq;
  // 立ち上がりと減衰を付けてプツッという音を防ぐ
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(SOUND_GAIN, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + duration);
}

// 「ピピピッ」
function playAlarmOnce() {
  for (let i = 0; i < 3; i++) tone(1760, i * 0.15, 0.1);
}

// 低めでやわらかい「ポーン」
function playSoft() {
  tone(660, 0, 1.2);
}

function startAlarm() {
  stopSound();
  playAlarmOnce();
  alarmTimer = window.setInterval(playAlarmOnce, ALARM_REPEAT_MS);
  alarmStopTimer = window.setTimeout(stopSound, ALARM_MAX_MS);
}

function stopSound() {
  window.clearInterval(alarmTimer);
  window.clearTimeout(alarmStopTimer);
}

mascot.onStopSound(stopSound);

// ---- 吹き出し ----
let bubbleTimer: number | undefined;

// ms = 0 ならクリックされるまで表示し続ける
function say(text: string, ms = BUBBLE_MS) {
  bubble.textContent = text;
  bubble.hidden = false;
  window.clearTimeout(bubbleTimer);
  if (ms > 0) bubbleTimer = window.setTimeout(hideBubble, ms);
}

function hideBubble() {
  bubble.hidden = true;
  window.clearTimeout(bubbleTimer);
}

bubble.addEventListener("click", () => {
  stopSound();
  hideBubble();
});

mascot.onSay((text, ms, sound) => {
  if (state === "sleep") setState("idle");
  resetSleepTimer();
  say(text, ms);
  if (sound === "alarm") startAlarm();
  if (sound === "soft") playSoft();
});

// ---- 揺れ：足元を軸に左右へ傾く ----
function sway() {
  motion = sprite.animate([
    { transform: "rotate(0deg)", easing: "ease-out" },
    { transform: `rotate(-${SWAY_DEG}deg)`, easing: "ease-in" },
    { transform: "rotate(0deg)", easing: "ease-out" },
    { transform: `rotate(${SWAY_DEG}deg)`, easing: "ease-in" },
    { transform: "rotate(0deg)" },
  ], { duration: SWAY_PERIOD_MS, iterations: ANIMATIONS.sway.interval / SWAY_PERIOD_MS });
}

// ---- 歩き回り：小さく跳ねながら進む ----
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

// 待機中にときどき「歩く・ポーズ・揺れる」のどれかを等確率で行う
const IDLE_ACTIONS: (() => void)[] = [
  () => void walk(),
  () => setState("pose"),
  () => setState("sway"),
];

window.setInterval(() => {
  if (state !== "idle" || walking || dragStart || Math.random() >= ACTION_CHANCE) return;
  IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)]();
}, ACTION_CHECK_MS);

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
  if (!dragged && state !== "idle") setState("idle");
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
    stopSound();
    setState("click");
    say(CLICK_LINES[Math.floor(Math.random() * CLICK_LINES.length)]);
  }
  resetSleepTimer();
});

sprite.addEventListener("dragstart", (e) => e.preventDefault());

setState("idle");
resetSleepTimer();
