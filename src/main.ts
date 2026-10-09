import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, Tray } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

// ウィンドウはスプライト(100px)＋上部の吹き出し領域
const WIN_W = 200;
const WIN_H = 180;
const SNAP_TO_GROUND_PX = 40;
const ROOT = path.join(__dirname, "..");

type SavedState = { x: number; y: number; chime: boolean; sound: boolean };
// alarm: 止めるまで鳴らし続ける / soft: 控えめに 1 回
type Sound = "alarm" | "soft";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let chime = true;
let sound = true;

const statePath = () => path.join(app.getPath("userData"), "state.json");

function loadState(): Partial<SavedState> {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), "utf8")) as Partial<SavedState>;
    if (typeof s.chime === "boolean") chime = s.chime;
    if (typeof s.sound === "boolean") sound = s.sound;
    // 保存位置が現在のどのディスプレイ上にもなければ無視する
    const onScreen = typeof s.x === "number" && typeof s.y === "number" &&
      screen.getAllDisplays().some(({ workArea: a }) =>
        s.x! >= a.x && s.y! >= a.y && s.x! + WIN_W <= a.x + a.width && s.y! + WIN_H <= a.y + a.height);
    return onScreen ? s : {};
  } catch {
    return {};
  }
}

function saveState() {
  if (!win) return;
  const [x, y] = win.getPosition();
  const s: SavedState = { x, y, chime, sound };
  try {
    fs.writeFileSync(statePath(), JSON.stringify(s));
  } catch (e) {
    console.error("failed to save state:", e);
  }
}

function workArea() {
  return win ? screen.getDisplayMatching(win.getBounds()).workArea : screen.getPrimaryDisplay().workArea;
}

const groundY = () => { const a = workArea(); return a.y + a.height - WIN_H; };

function moveTo(x: number, y: number) {
  win?.setBounds({ x: Math.round(x), y: Math.round(y), width: WIN_W, height: WIN_H });
}

function createWindow() {
  const saved = loadState();
  const a = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    x: saved.x ?? a.x + a.width - WIN_W - 40,
    y: saved.y ?? a.y + a.height - WIN_H,
    width: WIN_W,
    height: WIN_H,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // 操作なしでも通知音を鳴らせるようにする
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  // 透明部分はクリック透過。キャラ/吹き出しの上だけ renderer から解除する
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(ROOT, "renderer", "index.html"));
}

// ms = 0 ならクリックされるまで表示し続ける
function say(text: string, ms?: number, soundType?: Sound) {
  if (!win) return;
  if (!win.isVisible()) win.showInactive();
  win.webContents.send("say", text, ms, sound ? soundType : undefined);
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else win.show();
}

// ---- 時報 ----
let chimeTimer: NodeJS.Timeout | undefined;

function scheduleChime() {
  clearTimeout(chimeTimer);
  const next = new Date();
  next.setHours(next.getHours() + 1, 0, 0, 0);
  chimeTimer = setTimeout(() => {
    if (chime) say(`${new Date().getHours()}時だよ！`, 8000);
    scheduleChime();
  }, next.getTime() - Date.now());
}

// ---- タイマー ----
let timer: { timeout: NodeJS.Timeout; minutes: number } | null = null;

function startTimer(minutes: number) {
  stopTimer();
  timer = { minutes, timeout: setTimeout(() => {
    timer = null;
    say(`${minutes}分たったよ！`, 0, "alarm");
    updateTrayMenu();
  }, minutes * 60_000) };
  say(`${minutes}分はかるね`);
  updateTrayMenu();
}

function stopTimer() {
  if (!timer) return;
  clearTimeout(timer.timeout);
  timer = null;
  updateTrayMenu();
}

// ---- ポモドーロ（25分作業 / 5分休憩） ----
const POMODORO_WORK_MIN = 25;
const POMODORO_BREAK_MIN = 5;
let pomodoro: { timeout: NodeJS.Timeout; phase: "work" | "break" } | null = null;

function runPomodoro(phase: "work" | "break") {
  const minutes = phase === "work" ? POMODORO_WORK_MIN : POMODORO_BREAK_MIN;
  pomodoro = { phase, timeout: setTimeout(() => {
    if (phase === "work") say(`おつかれさま！${POMODORO_BREAK_MIN}分休憩しよう`, 15000, "soft");
    else say("休憩おわり！作業再開だよ", 15000, "soft");
    runPomodoro(phase === "work" ? "break" : "work");
  }, minutes * 60_000) };
  updateTrayMenu();
}

function togglePomodoro() {
  if (pomodoro) {
    clearTimeout(pomodoro.timeout);
    pomodoro = null;
    say("ポモドーロおわり");
    updateTrayMenu();
  } else {
    say(`${POMODORO_WORK_MIN}分がんばろう！`);
    runPomodoro("work");
  }
}

// ---- PC 起動時の自動実行 ----
// 開発時は electron.exe にプロジェクトのパスを渡して起動する
const loginArgs = () => (app.isPackaged ? [] : [app.getAppPath()]);

function isAutoStart() {
  return app.getLoginItemSettings({ args: loginArgs() }).openAtLogin;
}

function setAutoStart(enabled: boolean) {
  app.setLoginItemSettings({ openAtLogin: enabled, args: loginArgs() });
}

// ---- トレイ ----
function createTray() {
  const icon = nativeImage
    .createFromPath(path.join(ROOT, "imgs", "mouse_slime_1.png"))
    .resize({ width: 16, height: 16, quality: "good" });
  tray = new Tray(icon);
  tray.setToolTip("desktop_mascot");
  tray.on("click", toggleVisible);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const pomodoroLabel = !pomodoro ? "ポモドーロ開始"
    : `ポモドーロ停止（${pomodoro.phase === "work" ? "作業中" : "休憩中"}）`;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "表示 / 非表示", click: toggleVisible },
    { type: "separator" },
    {
      label: timer ? `タイマー（${timer.minutes}分 計測中）` : "タイマー",
      submenu: [
        ...[3, 5, 10, 30, 60].map((m) => ({ label: `${m}分`, click: () => startTimer(m) })),
        { type: "separator" as const },
        { label: "停止", enabled: timer !== null, click: stopTimer },
      ],
    },
    { label: pomodoroLabel, click: togglePomodoro },
    {
      label: "時報",
      type: "checkbox",
      checked: chime,
      click: (item) => { chime = item.checked; saveState(); },
    },
    {
      label: "音",
      type: "checkbox",
      checked: sound,
      click: (item) => {
        sound = item.checked;
        if (!sound) win?.webContents.send("stop-sound");
        saveState();
      },
    },
    {
      label: "PC起動時に自動実行",
      type: "checkbox",
      checked: isAutoStart(),
      click: (item) => setAutoStart(item.checked),
    },
    { type: "separator" },
    { label: "終了", click: () => app.quit() },
  ]));
}

// ---- IPC ----
ipcMain.on("set-ignore-mouse", (_e, ignore: boolean) => {
  win?.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.on("drag-move", (_e, dx: number, dy: number) => {
  if (!win) return;
  const [x, y] = win.getPosition();
  moveTo(x + dx, y + dy);
});

ipcMain.on("drag-end", () => {
  if (!win) return;
  // 地面の近くで離したら地面に着地させる
  const [x, y] = win.getPosition();
  const g = groundY();
  if (Math.abs(y - g) <= SNAP_TO_GROUND_PX) moveTo(x, g);
  saveState();
});

// 地面の上にいるときだけ左右に歩く。歩けなかったら false を返す
ipcMain.handle("walk-step", (_e, dx: number): boolean => {
  if (!win) return false;
  const [x, y] = win.getPosition();
  const a = workArea();
  if (Math.abs(y - groundY()) > 2) return false;
  const nx = Math.min(Math.max(x + dx, a.x), a.x + a.width - WIN_W);
  if (nx === x) return false;
  moveTo(nx, y);
  return true;
});

ipcMain.on("walk-end", saveState);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    createWindow();
    createTray();
    scheduleChime();
  });
  app.on("before-quit", saveState);
}
