const $ = (s, root = document) => root.querySelector(s);
const SAVED_KEY_STORE = "sb_saved_keys";
const DEVICE_STORE = "sb_device_id";

/* ---------------- Splash ---------------- */
// Branding stays fully visible for a perceivable time: ~2s on first open, shorter on reloads in the same session.
const splash = $("#splash");
const splashInner = $("#splashInner");
const firstOpen = !sessionStorage.getItem("sb_splash_seen");
const splashMin = firstOpen ? 2000 : 1100;
document.body.classList.add("splashing");

const logoReady = new Promise((resolve) => {
  const img = $("#splashLogo");
  const done = () => (img.decode ? img.decode().catch(() => {}).then(resolve) : resolve());
  img.complete ? done() : img.addEventListener("load", done, { once: true });
  img.addEventListener("error", resolve, { once: true });
});
const splashShown = logoReady.then(() => {
  // Only start the reveal once the logo is decoded, so branding never appears half-loaded.
  splashInner.classList.add("show");
  return new Promise((r) => setTimeout(r, splashMin));
});
const timeout = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- Content ---------------- */
const isSafeUrl = (u) => {
  if (!u) return false;
  if (u.startsWith("/") && !u.startsWith("//")) return true;
  try { return ["https:", "http:"].includes(new URL(u).protocol); } catch { return false; }
};
let settings = null;

function get(path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), settings);
}

function applySettings(s) {
  settings = s;
  document.querySelectorAll("[data-bind]").forEach((el) => {
    const v = get(el.dataset.bind);
    if (typeof v === "string") el.textContent = v;
  });
  const setLink = (el, url) => { if (isSafeUrl(url)) el.href = url; };
  setLink($("#contactBtn"), s.contact.url);
  setLink($("#screenshotBtn"), s.payment.screenshotUrl);
  setLink($("#booksBtn"), s.books.url);
  setLink($("#telegramBtn"), s.telegram.url);

  if (/^#[0-9a-f]{6}$/i.test(s.brand.accent || "")) document.documentElement.style.setProperty("--gold", s.brand.accent);
  if (isSafeUrl(s.brand.logoUrl) && !$("#brandLogo").src.endsWith(s.brand.logoUrl)) $("#brandLogo").src = s.brand.logoUrl;
  if (isSafeUrl(s.payment.qrUrl)) $("#qrImg").dataset.src = s.payment.qrUrl;

  const benefits = $("#benefits");
  benefits.replaceChildren(...(s.payment.benefits || []).map((b) => Object.assign(document.createElement("li"), { textContent: b })));

  if (s.general.siteTitle) document.title = s.general.siteTitle;
  if (s.general.metaDescription) document.querySelector('meta[name="description"]').content = s.general.metaDescription;
}

function renderPlatforms(list) {
  $("#platformList").replaceChildren(
    ...list.map((p) => {
      const li = document.createElement("li");
      const el = isSafeUrl(p.url) ? Object.assign(document.createElement("a"), { href: p.url, target: "_blank", rel: "noopener" }) : document.createElement("span");
      el.textContent = p.name;
      li.append(el);
      return li;
    }),
  );
}

const configLoaded = fetch("/api/config", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((data) => {
    applySettings(data.settings);
    renderPlatforms(data.platforms);
    if (data.settings.general.splashEnabled === false) return "skip";
  })
  .catch(() => {
    $("#platformList").replaceChildren(Object.assign(document.createElement("li"), { innerHTML: "<span>Could not load platforms. Pull to refresh.</span>" }));
  });

const splashFinished = configLoaded.then((r) => (r === "skip" ? logoReady : splashShown));
Promise.race([splashFinished, timeout(4500)]).then(() => {
  sessionStorage.setItem("sb_splash_seen", "1");
  splash.classList.add("done");
  document.body.classList.remove("splashing");
  setTimeout(() => splash.remove(), 700);
});

/* ---------------- Accordions ---------------- */
function toggleAcc(acc, onOpen) {
  const btn = $(".acc-btn", acc);
  btn.addEventListener("click", () => {
    const open = !acc.classList.contains("open");
    acc.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    if (open && onOpen) onOpen();
    if (!open) acc.querySelectorAll("video").forEach((v) => v.pause());
  });
}

toggleAcc($("#demoAcc"), () => {
  // Lazy-load: the video element is created only when the demo is first opened.
  const slot = $("#videoSlot");
  const url = settings?.demo?.videoUrl;
  if (slot.dataset.loaded === url) return;
  slot.dataset.loaded = url || "";
  if (!isSafeUrl(url)) {
    slot.replaceChildren(Object.assign(document.createElement("div"), { className: "video-empty", textContent: "The demo video will appear here once it is published." }));
    return;
  }
  const video = document.createElement("video");
  Object.assign(video, { controls: true, preload: "metadata", playsInline: true });
  video.setAttribute("controlsList", "nodownload");
  const source = document.createElement("source");
  source.src = url;
  if (settings.demo.videoType) source.type = settings.demo.videoType;
  video.append(source);
  slot.replaceChildren(video);
});

toggleAcc($("#payAcc"), () => {
  const qr = $("#qrImg");
  if (qr.getAttribute("src") !== qr.dataset.src) qr.src = qr.dataset.src;
});
toggleAcc($("#platformAcc"));

/* ---------------- Key input ---------------- */
const keyInput = $("#keyInput");
const eyeBtn = $("#eyeBtn");
eyeBtn.addEventListener("click", () => {
  const show = keyInput.type === "password";
  keyInput.type = show ? "text" : "password";
  eyeBtn.setAttribute("aria-pressed", String(show));
  eyeBtn.setAttribute("aria-label", show ? "Hide key" : "Show key");
});

/* ---------------- Saved keys (this device only, only after server validation) ---------------- */
const readSaved = () => {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY_STORE) || "[]").filter((k) => typeof k === "string"); } catch { return []; }
};
const writeSaved = (list) => localStorage.setItem(SAVED_KEY_STORE, JSON.stringify(list));
const mask = (k) => (k.length <= 8 ? k.replace(/./g, "•") : `${k.slice(0, 4)}-••••-${k.slice(-4)}`);

function renderSaved() {
  const list = readSaved();
  $("#savedCount").textContent = String(list.length);
  const box = $("#savedList");
  if (!list.length) {
    box.replaceChildren(Object.assign(document.createElement("p"), { className: "saved-empty", textContent: "No saved keys yet." }));
    return;
  }
  box.replaceChildren(
    ...list.map((key) => {
      const row = document.createElement("div");
      row.className = "saved-item";
      const use = Object.assign(document.createElement("button"), { type: "button", className: "saved-use", textContent: mask(key) });
      use.setAttribute("aria-label", "Use this saved key");
      use.addEventListener("click", () => {
        keyInput.value = key;
        setMsg("");
        toggleSaved(false);
        keyInput.focus();
      });
      const remove = Object.assign(document.createElement("button"), { type: "button", className: "saved-remove", innerHTML: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z"/></svg>' });
      remove.setAttribute("aria-label", "Remove saved key");
      remove.addEventListener("click", () => {
        writeSaved(readSaved().filter((k) => k !== key));
        renderSaved();
      });
      row.append(use, remove);
      return row;
    }),
  );
}
function toggleSaved(force) {
  const box = $("#savedList");
  const open = force ?? box.hidden;
  box.hidden = !open;
  $("#savedBtn").setAttribute("aria-expanded", String(open));
}
$("#savedBtn").addEventListener("click", () => toggleSaved());
renderSaved();

/* ---------------- Login ---------------- */
function deviceId() {
  let id = localStorage.getItem(DEVICE_STORE);
  if (!id || !/^[A-Za-z0-9_-]{20,128}$/.test(id)) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    localStorage.setItem(DEVICE_STORE, id);
  }
  return id;
}

const msg = $("#loginMsg");
function setMsg(text, ok = false) {
  msg.textContent = text;
  msg.classList.toggle("ok", ok);
}

let submitting = false;
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (submitting) return;
  const key = keyInput.value.trim().toUpperCase();
  if (!key) {
    setMsg("Please enter your member key.");
    keyInput.focus();
    return;
  }
  submitting = true;
  const btn = $("#loginBtn");
  btn.disabled = true;
  btn.classList.add("loading");
  $(".btn-label", btn).textContent = "CHECKING…";
  setMsg("");
  let redirecting = false;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, deviceId: deviceId() }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok && data.destination) {
      if ($("#saveKey").checked && !readSaved().includes(key)) {
        writeSaved([key, ...readSaved()].slice(0, 10));
        renderSaved();
      }
      setMsg("Access granted. Opening your content…", true);
      $(".btn-label", btn).textContent = "OPENING…";
      redirecting = true;
      setTimeout(() => window.location.assign(data.destination), 450);
      return;
    }
    setMsg(data.error || "Wrong key. Please make the payment and receive your key, then login.");
  } catch {
    setMsg("Network error. Please check your connection and try again.");
  } finally {
    if (!redirecting) {
      submitting = false;
      btn.disabled = false;
      btn.classList.remove("loading");
      $(".btn-label", btn).textContent = "LOGIN";
    }
  }
});

// If the user returns via the back button, restore the button state.
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  submitting = false;
  const btn = $("#loginBtn");
  btn.disabled = false;
  btn.classList.remove("loading");
  $(".btn-label", btn).textContent = "LOGIN";
  setMsg("");
});

/* ---------------- Service worker (network-first, auto-updating) ---------------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
