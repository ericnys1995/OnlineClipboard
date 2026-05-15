import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";
import { getDatabase, ref, onValue, set, remove, get } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyAUNAGQnXBXGoBJvrthv4uOhNF9mXp_TEw",
  authDomain: "onlineclipboard-9ff7a.firebaseapp.com",
  databaseURL: "https://onlineclipboard-9ff7a-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "onlineclipboard-9ff7a",
  storageBucket: "onlineclipboard-9ff7a.firebasestorage.app",
  messagingSenderId: "380156673584",
  appId: "1:380156673584:web:925a0658bce99ae4fff7f5",
  measurementId: "G-3B9V7K0XYX"
};

const SETTINGS = {
  SLOT_COUNT: 24,
  PBKDF2_ITERATIONS: 250_000,
  // Ciphertext is base64, so it grows by roughly 33%.
  // Keep plaintext below ~7 MiB to avoid Firebase single-string limits.
  SOFT_LIMIT_BYTES: 5 * 1024 * 1024,
  HARD_LIMIT_BYTES: 7 * 1024 * 1024,
  EXPIRED_CLEANUP_INTERVAL_MS: 60_000
};

const els = {
  authStatus: document.querySelector("#authStatus"),
  roomStatus: document.querySelector("#roomStatus"),
  roomInput: document.querySelector("#roomInput"),
  passInput: document.querySelector("#passInput"),
  connectBtn: document.querySelector("#connectBtn"),
  setupMessage: document.querySelector("#setupMessage"),
  syncStatus: document.querySelector("#syncStatus"),
  clearExpiredBtn: document.querySelector("#clearExpiredBtn"),
  lockBtn: document.querySelector("#lockBtn"),
  slotsGrid: document.querySelector("#slotsGrid"),
  slotTemplate: document.querySelector("#slotTemplate")
};

let app;
let auth;
let db;
let userId = null;
let roomName = "";
let roomKey = "";
let cryptoKey = null;
let slotsRef = null;
let unsubscribeSlots = null;
let cleanupTimer = null;
let connected = false;
let initialRenderDone = false;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

initUI();

function initUI() {
  buildSlots();

  const savedRoom = localStorage.getItem("rtclip_room") || "";
  els.roomInput.value = savedRoom;

  els.connectBtn.addEventListener("click", connect);
  els.passInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") connect();
  });

  els.clearExpiredBtn.addEventListener("click", clearExpiredSlots);
  els.lockBtn.addEventListener("click", lockApp);

  els.slotsGrid.addEventListener("click", async (event) => {
    const card = event.target.closest(".slot-card");
    if (!card) return;
    const slotId = card.dataset.slotId;

    if (event.target.matches(".save-btn")) await saveSlot(slotId, card);
    if (event.target.matches(".copy-btn")) await copySlot(card);
    if (event.target.matches(".clear-btn")) await clearSlot(slotId, card);
  });

  els.slotsGrid.addEventListener("keydown", async (event) => {
    const card = event.target.closest(".slot-card");
    if (!card) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      await saveSlot(card.dataset.slotId, card);
    }
  });

  els.slotsGrid.addEventListener("input", (event) => {
    const card = event.target.closest(".slot-card");
    if (!card) return;
    if (event.target.matches(".slot-text, .slot-label")) {
      card.dataset.dirty = "true";
      card.querySelector(".slot-updated").textContent = "有未儲存改動";
      updateLocalSize(card);
    }
  });

  showSetupMessage("先喺 app.js 貼 Firebase config，再喺 Firebase Console 開 Anonymous Auth + Realtime Database。", "info");
}

function buildSlots() {
  els.slotsGrid.innerHTML = "";
  for (let i = 1; i <= SETTINGS.SLOT_COUNT; i += 1) {
    const node = els.slotTemplate.content.cloneNode(true);
    const card = node.querySelector(".slot-card");
    card.dataset.slotId = String(i);
    card.dataset.dirty = "false";
    card.querySelector(".slot-label").value = `Slot ${String(i).padStart(2, "0")}`;
    els.slotsGrid.appendChild(node);
  }
}

async function connect() {
  try {
    ensureFirebaseConfigLooksFilled();

    roomName = els.roomInput.value.trim();
    const passphrase = els.passInput.value;

    if (roomName.length < 3) throw new Error("Room name 至少 3 個字。");
    if (passphrase.length < 10) throw new Error("Passphrase 建議至少 10 個字，兩部機要一樣。");

    setBusy(true, "連接中…");

    if (!app) {
      app = initializeApp(firebaseConfig);
      auth = getAuth(app);
      db = getDatabase(app);
    }

    const credential = await signInAnonymously(auth);
    userId = credential.user.uid;

    roomKey = await sha256Base64Url(`rtclip-room:${roomName}:${passphrase}`);
    cryptoKey = await deriveAesKey(passphrase, `rtclip-salt:${roomName}`);
    slotsRef = ref(db, `rooms/${roomKey}/slots`);

    localStorage.setItem("rtclip_room", roomName);
    els.passInput.value = "";

    connected = true;
    initialRenderDone = false;
    els.authStatus.textContent = "Firebase connected";
    els.authStatus.className = "pill ok";
    els.roomStatus.textContent = `Room: ${roomName}`;
    els.roomStatus.className = "pill ok";
    els.syncStatus.textContent = "監聽中…";

    if (typeof unsubscribeSlots === "function") unsubscribeSlots();
    unsubscribeSlots = onValue(slotsRef, async (snapshot) => {
      await applyRemoteSlots(snapshot.val() || {});
      if (!initialRenderDone) {
        showSetupMessage("已連接。兩部機用同一 room + passphrase 就會同步。", "success");
        initialRenderDone = true;
      }
    }, (error) => {
      showSetupMessage(`Firebase read error: ${error.message}`, "error");
      els.syncStatus.textContent = "同步失敗";
    });

    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = setInterval(clearExpiredSlots, SETTINGS.EXPIRED_CLEANUP_INTERVAL_MS);
    await clearExpiredSlots();
  } catch (error) {
    connected = false;
    showSetupMessage(error.message, "error");
    els.authStatus.textContent = "Firebase 未連接";
    els.authStatus.className = "pill error";
  } finally {
    setBusy(false);
  }
}

function lockApp() {
  connected = false;
  cryptoKey = null;
  roomKey = "";
  slotsRef = null;
  userId = null;
  if (typeof unsubscribeSlots === "function") unsubscribeSlots();
  unsubscribeSlots = null;
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;

  buildSlots();
  els.authStatus.textContent = "Locked";
  els.authStatus.className = "pill muted";
  els.roomStatus.textContent = "No room";
  els.roomStatus.className = "pill muted";
  els.syncStatus.textContent = "已 lock，需要重新輸入 passphrase";
  showSetupMessage("已 lock。重新輸入 passphrase 先可以解密。", "info");
}

async function saveSlot(slotId, card) {
  try {
    requireConnected();

    const text = card.querySelector(".slot-text").value;
    const label = card.querySelector(".slot-label").value.trim() || `Slot ${slotId}`;
    const ttlMs = Number(card.querySelector(".slot-ttl").value);
    const sizeBytes = byteSize(text);

    if (sizeBytes > SETTINGS.HARD_LIMIT_BYTES) {
      throw new Error(`太大：${formatBytes(sizeBytes)}。呢版 hard limit 係 ${formatBytes(SETTINGS.HARD_LIMIT_BYTES)}。`);
    }

    if (sizeBytes > SETTINGS.SOFT_LIMIT_BYTES) {
      const ok = confirm(`呢段有 ${formatBytes(sizeBytes)}，同步會比較慢同用多啲 Firebase traffic。照 save？`);
      if (!ok) return;
    }

    card.classList.add("is-saving");
    const encrypted = await encryptText(text);
    const now = Date.now();
    const expiresAt = ttlMs > 0 ? now + ttlMs : 0;

    await set(ref(db, `rooms/${roomKey}/slots/${slotId}`), {
      version: 1,
      label,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      updatedAt: now,
      expiresAt,
      sizeBytes,
      updatedBy: userId ? userId.slice(0, 8) : "unknown"
    });

    card.dataset.dirty = "false";
    markCardSaved(card, now, expiresAt, sizeBytes);
    els.syncStatus.textContent = `Slot ${slotId} saved`;
  } catch (error) {
    setCardError(card, error.message);
  } finally {
    card.classList.remove("is-saving");
  }
}

async function copySlot(card) {
  const text = card.querySelector(".slot-text").value;
  try {
    await navigator.clipboard.writeText(text);
    const meta = card.querySelector(".slot-updated");
    const old = meta.textContent;
    meta.textContent = "已 copy";
    setTimeout(() => { meta.textContent = old; }, 1200);
  } catch {
    card.querySelector(".slot-text").select();
    document.execCommand("copy");
  }
}

async function clearSlot(slotId, card) {
  try {
    requireConnected();
    const ok = confirm(`Clear Slot ${slotId}?`);
    if (!ok) return;
    await remove(ref(db, `rooms/${roomKey}/slots/${slotId}`));
    resetCard(card, slotId);
    els.syncStatus.textContent = `Slot ${slotId} cleared`;
  } catch (error) {
    setCardError(card, error.message);
  }
}

async function clearExpiredSlots() {
  if (!connected || !db || !roomKey) return;
  const snapshot = await get(ref(db, `rooms/${roomKey}/slots`));
  const slots = snapshot.val() || {};
  const now = Date.now();
  const removals = [];

  for (const [slotId, data] of Object.entries(slots)) {
    if (data?.expiresAt && data.expiresAt > 0 && data.expiresAt <= now) {
      removals.push(remove(ref(db, `rooms/${roomKey}/slots/${slotId}`)));
    }
  }

  if (removals.length > 0) {
    await Promise.all(removals);
    els.syncStatus.textContent = `Cleared ${removals.length} expired slot(s)`;
  }
}

async function applyRemoteSlots(slots) {
  const now = Date.now();
  const cards = [...document.querySelectorAll(".slot-card")];

  for (const card of cards) {
    const slotId = card.dataset.slotId;
    const data = slots[slotId];

    if (!data) {
      if (card.dataset.dirty !== "true") resetCard(card, slotId, false);
      continue;
    }

    if (data.expiresAt && data.expiresAt > 0 && data.expiresAt <= now) {
      if (card.dataset.dirty !== "true") resetCard(card, slotId, false);
      continue;
    }

    if (card.dataset.dirty === "true") {
      card.classList.add("has-remote-update");
      card.querySelector(".slot-updated").textContent = "有 remote update；save 會覆蓋";
      continue;
    }

    try {
      const text = await decryptText(data);
      card.querySelector(".slot-text").value = text;
      card.querySelector(".slot-label").value = data.label || `Slot ${slotId}`;
      card.dataset.dirty = "false";
      card.classList.remove("has-remote-update");
      markCardSaved(card, data.updatedAt, data.expiresAt, data.sizeBytes ?? byteSize(text));
    } catch {
      card.querySelector(".slot-text").value = "[解密失敗：room/passphrase 可能唔同，或者資料已損壞]";
      setCardError(card, "解密失敗");
    }
  }

  els.syncStatus.textContent = `Last sync: ${new Date().toLocaleTimeString()}`;
}

function resetCard(card, slotId, resetLabel = true) {
  if (resetLabel) card.querySelector(".slot-label").value = `Slot ${String(slotId).padStart(2, "0")}`;
  card.querySelector(".slot-text").value = "";
  card.querySelector(".slot-size").textContent = "0 B";
  card.querySelector(".slot-updated").textContent = "未同步";
  card.querySelector(".slot-expiry").textContent = "No TTL";
  card.dataset.dirty = "false";
  card.classList.remove("has-remote-update", "has-error");
}

function markCardSaved(card, updatedAt, expiresAt, sizeBytes) {
  card.classList.remove("has-error", "has-remote-update");
  card.querySelector(".slot-size").textContent = formatBytes(sizeBytes || 0);
  card.querySelector(".slot-updated").textContent = updatedAt ? `Updated ${formatTime(updatedAt)}` : "Saved";
  card.querySelector(".slot-expiry").textContent = expiresAt ? `Expires ${formatTime(expiresAt)}` : "No TTL";
}

function updateLocalSize(card) {
  const text = card.querySelector(".slot-text").value;
  const size = byteSize(text);
  const el = card.querySelector(".slot-size");
  el.textContent = formatBytes(size);
  el.classList.toggle("warn", size > SETTINGS.SOFT_LIMIT_BYTES);
}

function setCardError(card, message) {
  card.classList.add("has-error");
  card.querySelector(".slot-updated").textContent = message;
}

function requireConnected() {
  if (!connected || !db || !roomKey || !cryptoKey) {
    throw new Error("未 connect room，或者已 lock。");
  }
}

function ensureFirebaseConfigLooksFilled() {
  const missing = Object.values(firebaseConfig).some((value) => !value || String(value).startsWith("PASTE_"));
  if (missing) {
    throw new Error("請先喺 app.js 貼 Firebase config，包括 databaseURL、apiKey、authDomain、projectId、appId。");
  }
}

function setBusy(isBusy, text = "") {
  els.connectBtn.disabled = isBusy;
  els.connectBtn.textContent = isBusy ? text : "Connect";
}

function showSetupMessage(message, type = "info") {
  els.setupMessage.textContent = message;
  els.setupMessage.className = `message ${type}`;
}

async function deriveAesKey(passphrase, saltText) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(saltText),
      iterations: SETTINGS.PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptText(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encoder.encode(text)
  );

  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  };
}

async function decryptText(data) {
  const iv = base64ToBytes(data.iv);
  const ciphertext = base64ToBytes(data.ciphertext);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    ciphertext
  );
  return decoder.decode(plaintext);
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return base64Url(new Uint8Array(digest));
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64Url(bytes) {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function byteSize(text) {
  return encoder.encode(text).byteLength;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = units.shift();
  while (size >= 1024 && units.length > 0) {
    size /= 1024;
    unit = units.shift();
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

function formatTime(timestamp) {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
