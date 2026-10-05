const $ = (s, root = document) => root.querySelector(s);

/* ---------------- Helpers ---------------- */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

async function api(path, { method = "GET", body, raw } = {}) {
  const headers = { "x-sb-admin": "1" };
  if (body !== undefined && !raw) headers["content-type"] = "application/json";
  const res = await fetch(`/api/admin/${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("auth/")) {
    showAuth("login", "Your session expired. Please log in again.");
    throw new Error(data.error || "Session expired.");
  }
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong."), { code: data.code, status: res.status });
  return data;
}

let toastTimer;
function toast(text, err = false) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.toggle("err", err);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

async function busy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("loading");
  try { return await fn(); } finally { btn.disabled = false; btn.classList.remove("loading"); }
}

const fmtDate = (d) => (d ? new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");

document.addEventListener("click", (e) => {
  const eye = e.target.closest("[data-eye]");
  if (!eye) return;
  const input = eye.parentElement.querySelector("input");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  eye.setAttribute("aria-pressed", String(show));
  eye.setAttribute("aria-label", show ? "Hide password" : "Show password");
});

/* ---------------- Auth views ---------------- */
const forms = ["loginForm", "forgotPhoneForm", "forgotOtpForm", "forgotNewForm"];
const formOf = { login: "loginForm", phone: "forgotPhoneForm", otp: "forgotOtpForm", newpw: "forgotNewForm" };
const reset = { phone: "", token: "" };

function showAuth(step = "login", message = "", ok = false) {
  $("#boot").hidden = true;
  $("#dashView").hidden = true;
  $("#authView").hidden = false;
  forms.forEach((id) => ($("#" + id).hidden = id !== formOf[step]));
  const form = $("#" + formOf[step]);
  const msg = $("[data-msg]", form);
  msg.textContent = message;
  msg.classList.toggle("ok", ok);
  form.querySelector("input")?.focus();
}

function formMsg(form, text, ok = false) {
  const m = $("[data-msg]", form);
  m.textContent = text;
  m.classList.toggle("ok", ok);
}

$("#loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $("button[type=submit]", form);
  busy(btn, async () => {
    formMsg(form, "");
    const phone = form.phone.value.trim();
    const password = form.password.value;
    if (!phone || !password) return formMsg(form, "Enter your phone number and password.");
    try {
      await api("auth/login", { method: "POST", body: { phone, password } });
      form.password.value = "";
      await openDashboard();
    } catch (err) {
      formMsg(form, err.message);
    }
  });
});

$("#forgotLink").addEventListener("click", () => {
  showAuth("phone");
  $("#forgotPhoneForm").phone.value = $("#loginForm").phone.value;
});
document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => showAuth("login")));

async function sendOtp(form, btn) {
  return busy(btn, async () => {
    formMsg(form, "");
    try {
      const data = await api("auth/forgot/start", { method: "POST", body: { phone: reset.phone } });
      showAuth("otp", `OTP sent to ${data.sentTo}. It expires in 10 minutes.`, true);
    } catch (err) {
      formMsg(form, err.message);
    }
  });
}

$("#forgotPhoneForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  reset.phone = form.phone.value.trim();
  if (!reset.phone) return formMsg(form, "Enter the registered phone number.");
  sendOtp(form, $("button[type=submit]", form));
});

$("#resendOtp").addEventListener("click", (e) => sendOtp($("#forgotOtpForm"), e.currentTarget));

$("#forgotOtpForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  busy($("button[type=submit]", form), async () => {
    formMsg(form, "");
    try {
      const data = await api("auth/forgot/verify", { method: "POST", body: { phone: reset.phone, code: form.code.value.trim() } });
      reset.token = data.resetToken;
      form.code.value = "";
      showAuth("newpw", "OTP verified. Create your new password.", true);
    } catch (err) {
      formMsg(form, err.message);
    }
  });
});

$("#forgotNewForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  busy($("button[type=submit]", form), async () => {
    formMsg(form, "");
    if (form.password.value.length < 8) return formMsg(form, "Password must be at least 8 characters.");
    if (form.password.value !== form.confirm.value) return formMsg(form, "Passwords do not match.");
    try {
      await api("auth/forgot/reset", { method: "POST", body: { resetToken: reset.token, password: form.password.value, confirm: form.confirm.value } });
      form.reset();
      reset.token = "";
      $("#loginForm").phone.value = reset.phone;
      showAuth("login", "Password updated. Log in with your new password.", true);
      $("#loginForm").password.focus();
    } catch (err) {
      formMsg(form, err.message);
    }
  });
});

$("#logoutBtn").addEventListener("click", async () => {
  await api("auth/logout", { method: "POST" }).catch(() => {});
  showAuth("login", "You have been logged out.", true);
});

/* ---------------- Dashboard ---------------- */
let state = { settings: {}, keys: [], platforms: [] };
let current = "keys";

const SECTIONS = [
  { id: "keys", label: "Member Keys", render: renderKeys },
  {
    id: "demo", label: "Login Demo", section: "demo", title: "LOGIN DEMO",
    fields: [
      { k: "title", label: "Title" },
      { k: "description", label: "Description", type: "textarea" },
      { k: "videoUrl", label: "Demo video", type: "video" },
    ],
  },
  {
    id: "payment", label: "Get Key / Payment", section: "payment", title: "GET KEY / PAYMENT",
    fields: [
      { k: "buttonLabel", label: "Section button label" },
      { k: "heading", label: "Heading" },
      { k: "price", label: "Price" },
      { k: "priceNote", label: "Price note" },
      { k: "description", label: "Description", type: "textarea" },
      { k: "qrUrl", label: "Payment QR code", type: "image" },
      { k: "benefits", label: "What You Get (one per line)", type: "list" },
      { k: "screenshotLabel", label: "Screenshot button text" },
      { k: "screenshotUrl", label: "Screenshot button link", type: "url" },
    ],
  },
  { id: "platforms", label: "Platforms", render: renderPlatforms },
  {
    id: "books", label: "Books", section: "books", title: "BOOKS",
    fields: [
      { k: "title", label: "Title" },
      { k: "description", label: "Description", type: "textarea" },
      { k: "buttonLabel", label: "Button text" },
      { k: "url", label: "Button link", type: "url" },
    ],
  },
  {
    id: "telegram", label: "Telegram", section: "telegram", title: "TELEGRAM",
    fields: [
      { k: "heading", label: "Heading" },
      { k: "buttonLabel", label: "Button text" },
      { k: "url", label: "Channel link", type: "url" },
    ],
  },
  {
    id: "contact", label: "Contact", section: "contact", title: "CONTACT (top-right button)",
    fields: [
      { k: "text", label: "Button text" },
      { k: "url", label: "Link", type: "url" },
    ],
  },
  {
    id: "branding", label: "Branding", section: "brand", title: "BRANDING",
    fields: [
      { k: "logoUrl", label: "Logo", type: "image" },
      { k: "appName", label: "App name" },
      { k: "subtitle", label: "Subtitle" },
      { k: "accent", label: "Accent colour", type: "color" },
    ],
  },
  { id: "general", label: "General", render: renderGeneral },
];

async function openDashboard() {
  state = await api("data");
  $("#boot").hidden = true;
  $("#authView").hidden = true;
  $("#dashView").hidden = false;
  renderTabs();
  renderSection();
}

async function refresh() {
  state = await api("data");
  renderSection();
}

function renderTabs() {
  $("#tabs").replaceChildren(
    ...SECTIONS.map((s) =>
      h("button", { type: "button", class: "tab" + (s.id === current ? " active" : ""), onclick: () => { current = s.id; renderTabs(); renderSection(); } }, s.label),
    ),
  );
}

function renderSection() {
  const s = SECTIONS.find((x) => x.id === current);
  const content = s.render ? s.render() : settingsCard(s.section, s.title, s.fields);
  $("#dashMain").replaceChildren(...[content].flat());
}

/* ---------- Generic settings form ---------- */
function settingsCard(section, title, fields, note) {
  const values = { ...state.settings[section] };
  const form = h("form", { class: "card", novalidate: true });
  const saveBtn = h("button", { class: "btn-gold", type: "submit" }, h("span", { class: "btn-label" }, "SAVE CHANGES"), h("span", { class: "spinner" }));

  async function save(extra = {}) {
    Object.assign(values, extra);
    const res = await api(`settings/${section}`, { method: "PUT", body: values });
    state.settings[section] = res.value;
    toast("Saved — live on the website now.");
  }

  form.append(
    h("h2", {}, title),
    note && h("p", { class: "section-note" }, note),
    ...fields.map((f) => fieldEl(f, values, save)),
    saveBtn,
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(saveBtn, () => save().catch((err) => toast(err.message, true)));
  });
  return form;
}

function fieldEl(f, values, save) {
  const v = values[f.k];
  if (f.type === "bool") {
    return h("label", { class: "check", style: "margin-top:14px" },
      h("input", { type: "checkbox", checked: !!v, onchange: (e) => (values[f.k] = e.target.checked) }), f.label);
  }
  if (f.type === "image" || f.type === "video") return mediaField(f, values, save);
  const common = { oninput: (e) => (values[f.k] = f.type === "list" ? e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) : e.target.value) };
  const input = f.type === "textarea" || f.type === "list"
    ? h("textarea", { ...common, rows: f.type === "list" ? 5 : 3 })
    : h("input", { ...common, type: f.type === "url" ? "url" : f.type === "color" ? "color" : "text", inputmode: f.type === "url" ? "url" : null });
  input.value = f.type === "list" ? (v || []).join("\n") : v ?? "";
  return h("label", { class: "fld" }, h("span", {}, f.label), input);
}

function mediaField(f, values, save) {
  const isVideo = f.type === "video";
  const preview = h("div", { class: "preview" });
  const bar = h("i");
  const progress = h("div", { class: "progress", hidden: true }, bar);
  const linkInput = h("input", { type: "url", inputmode: "url", placeholder: "https://… (or upload a file)" });

  function paint() {
    const url = values[f.k];
    linkInput.value = url || "";
    if (!url) return preview.replaceChildren(h("div", { class: "empty" }, isVideo ? "No video uploaded. The homepage shows a short notice instead." : "No image set."));
    preview.replaceChildren(isVideo ? h("video", { src: url, controls: true, preload: "metadata", playsInline: true }) : h("img", { src: url, alt: f.label }));
  }
  paint();

  const fileInput = h("input", {
    type: "file",
    accept: isVideo ? "video/mp4,video/webm,video/quicktime" : "image/png,image/jpeg,image/webp,image/svg+xml",
    onchange: async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      progress.hidden = false;
      bar.style.width = "0%";
      try {
        const url = await uploadFile(file, (p) => (bar.style.width = `${Math.round(p * 100)}%`));
        values[f.k] = url;
        await save(isVideo ? { [f.k]: url, videoType: file.type } : { [f.k]: url });
        paint();
      } catch (err) {
        toast(err.message, true);
      } finally {
        setTimeout(() => (progress.hidden = true), 600);
      }
    },
  });

  linkInput.addEventListener("change", () => {
    values[f.k] = linkInput.value.trim();
    if (isVideo) values.videoType = "";
    paint();
  });

  const removeBtn = h("button", {
    type: "button", class: "btn-sm danger",
    onclick: (e) => busy(e.currentTarget, async () => {
      if (!confirm(`Remove the current ${isVideo ? "video" : "image"}?`)) return;
      try {
        await save(isVideo ? { [f.k]: "", videoType: "" } : { [f.k]: "" });
        paint();
      } catch (err) { toast(err.message, true); }
    }),
  }, "Remove");

  return h("div", { class: "fld" },
    h("span", {}, f.label),
    preview,
    progress,
    h("div", { class: "row-actions" },
      h("span", { class: "btn-sm gold file-btn", role: "button", style: "display:inline-flex;align-items:center" }, values[f.k] ? "Replace (upload)" : "Upload", fileInput),
      removeBtn),
    h("label", { class: "fld" }, h("span", {}, "…or use a link"), linkInput),
  );
}

async function uploadFile(file, onProgress) {
  const init = await api("uploads", { method: "POST", body: { type: file.type, size: file.size } });
  for (let n = 0; n < init.chunks; n++) {
    const chunk = file.slice(n * init.chunkSize, (n + 1) * init.chunkSize);
    let tries = 0;
    for (;;) {
      try {
        await api(`uploads/${init.id}/${n}`, { method: "PUT", body: chunk, raw: true });
        break;
      } catch (err) {
        if (++tries >= 3 || err.status === 401) throw err;
      }
    }
    onProgress((n + 1) / init.chunks);
  }
  const done = await api(`uploads/${init.id}/complete`, { method: "POST", body: {} });
  return done.url;
}

/* ---------- Member keys ---------- */
function randomKey() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => abc[b % abc.length]).join("");
  return `${part()}-${part()}-${part()}`;
}

function keyForm(row, onDone) {
  const form = h("form", { class: row ? "item" : "card", novalidate: true });
  const key = h("input", { name: "access_key", type: "text", autocapitalize: "characters", spellcheck: false, required: true, value: row?.access_key || "" });
  const label = h("input", { name: "label", type: "text", value: row?.label || "", placeholder: "e.g. PW Batches" });
  const dest = h("input", { name: "destination_url", type: "url", inputmode: "url", required: true, value: row?.destination_url || "", placeholder: "https://…" });
  const enabled = h("input", { type: "checkbox", checked: row ? row.enabled : true });
  const submit = h("button", { class: "btn-gold", type: "submit" }, h("span", { class: "btn-label" }, row ? "SAVE KEY" : "ADD KEY"), h("span", { class: "spinner" }));
  form.append(
    !row && h("h2", {}, "MEMBER KEYS"),
    !row && h("p", { class: "section-note" }, "Each key works on one device at a time. Use RESET DEVICE to let a member move to a new phone."),
    h("div", { class: "grid2" },
      h("label", { class: "fld" }, h("span", {}, "Member key"), key,
        h("button", { type: "button", class: "btn-sm", style: "margin-top:8px", onclick: () => (key.value = randomKey()) }, "Generate random key")),
      h("label", { class: "fld" }, h("span", {}, "Label (admin only)"), label)),
    h("label", { class: "fld" }, h("span", {}, "Destination URL"), dest),
    h("label", { class: "check", style: "margin-top:10px" }, enabled, "Enabled"),
    h("div", { class: "row-actions" }, submit, row && h("button", { type: "button", class: "btn-outline", onclick: onDone }, "CANCEL")),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(submit, async () => {
      const body = { access_key: key.value, label: label.value, destination_url: dest.value.trim(), enabled: enabled.checked };
      try {
        await api(row ? `keys/${row.id}` : "keys", { method: row ? "PUT" : "POST", body });
        toast(row ? "Key updated." : "Key added.");
        await refresh();
      } catch (err) { toast(err.message, true); }
    });
  });
  return form;
}

function renderKeys() {
  const list = h("div", { class: "card" }, h("h2", {}, `ALL KEYS (${state.keys.length})`));
  if (!state.keys.length) list.append(h("div", { class: "empty" }, "No member keys yet."));
  for (const row of state.keys) {
    const item = h("div", { class: "item" });
    const action = (label, cls, fn, confirmText) =>
      h("button", { type: "button", class: `btn-sm ${cls}`, onclick: (e) => busy(e.currentTarget, async () => {
        if (confirmText && !confirm(confirmText)) return;
        try { await fn(); await refresh(); } catch (err) { toast(err.message, true); }
      }) }, label);
    const view = () => item.replaceChildren(
      h("div", { class: "item-head" },
        h("span", { class: "item-key" }, row.access_key),
        h("span", { class: `badge ${row.enabled ? "on" : "off"}` }, row.enabled ? "ENABLED" : "DISABLED"),
        h("span", { class: `badge ${row.device_bound ? "gold" : ""}` }, row.device_bound ? "DEVICE LINKED" : "NO DEVICE")),
      row.label && h("div", { class: "item-meta" }, row.label),
      h("div", { class: "item-dest" }, "→ ", row.destination_url),
      h("div", { class: "item-meta" }, `Logins: ${row.login_count} · Last login: ${fmtDate(row.last_login_at)}${row.device_bound ? ` · Linked: ${fmtDate(row.device_bound_at)}` : ""}`),
      h("div", { class: "row-actions" },
        h("button", { type: "button", class: "btn-sm", onclick: () => item.replaceChildren(keyForm(row, view)) }, "Edit"),
        action(row.enabled ? "Disable" : "Enable", "", async () => {
          await api(`keys/${row.id}`, { method: "PUT", body: { ...row, enabled: !row.enabled } });
          toast(row.enabled ? "Key disabled." : "Key enabled.");
        }),
        h("button", { type: "button", class: "btn-sm", disabled: !row.device_bound, onclick: (e) => busy(e.currentTarget, async () => {
          if (!confirm(`Unlink the device from ${row.access_key}? The next valid login will link a new device.`)) return;
          try { await api(`keys/${row.id}/reset-device`, { method: "POST", body: {} }); toast("Device unlinked."); await refresh(); } catch (err) { toast(err.message, true); }
        }) }, "RESET / UNLINK DEVICE"),
        action("Delete", "danger", async () => {
          await api(`keys/${row.id}`, { method: "DELETE" });
          toast("Key deleted.");
        }, `Delete key ${row.access_key}? This cannot be undone.`)),
    );
    view();
    list.append(item);
  }
  return [keyForm(null), list];
}

/* ---------- Platforms ---------- */
function renderPlatforms() {
  const heading = settingsCard("platforms", "AVAILABLE PLATFORMS", [{ k: "heading", label: "Section heading" }]);

  const add = h("form", { class: "card", novalidate: true });
  const name = h("input", { type: "text", required: true, placeholder: "Platform name" });
  const url = h("input", { type: "url", inputmode: "url", placeholder: "https://… (optional, authorized link)" });
  const addBtn = h("button", { class: "btn-gold", type: "submit" }, h("span", { class: "btn-label" }, "ADD PLATFORM"), h("span", { class: "spinner" }));
  add.append(h("h2", {}, "ADD PLATFORM"), h("label", { class: "fld" }, h("span", {}, "Name"), name), h("label", { class: "fld" }, h("span", {}, "Authorized URL"), url), addBtn);
  add.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(addBtn, async () => {
      try { await api("platforms", { method: "POST", body: { name: name.value, url: url.value.trim(), visible: true } }); toast("Platform added."); await refresh(); }
      catch (err) { toast(err.message, true); }
    });
  });

  const list = h("div", { class: "card" }, h("h2", {}, `PLATFORMS (${state.platforms.length})`),
    h("p", { class: "section-note" }, "Use ▲ ▼ to reorder. Hidden platforms are not shown on the homepage. Only add links you are authorized to share."));
  const move = async (i, dir) => {
    const ids = state.platforms.map((p) => p.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api("platforms/reorder", { method: "POST", body: { ids } });
    await refresh();
  };
  state.platforms.forEach((p, i) => {
    const pName = h("input", { type: "text", value: p.name });
    const pUrl = h("input", { type: "url", inputmode: "url", value: p.url, placeholder: "No link" });
    const vis = h("input", { type: "checkbox", checked: p.visible });
    const saveP = h("button", { type: "button", class: "btn-sm gold", onclick: (e) => busy(e.currentTarget, async () => {
      try { await api(`platforms/${p.id}`, { method: "PUT", body: { name: pName.value, url: pUrl.value.trim(), visible: vis.checked } }); toast("Platform saved."); await refresh(); }
      catch (err) { toast(err.message, true); }
    }) }, "Save");
    const del = h("button", { type: "button", class: "btn-sm danger", onclick: (e) => busy(e.currentTarget, async () => {
      if (!confirm(`Delete “${p.name}”?`)) return;
      try { await api(`platforms/${p.id}`, { method: "DELETE" }); toast("Platform deleted."); await refresh(); } catch (err) { toast(err.message, true); }
    }) }, "Delete");
    list.append(h("div", { class: "item plat" },
      h("div", { class: "plat-move" },
        h("button", { type: "button", class: "btn-sm", disabled: i === 0, "aria-label": "Move up", onclick: (e) => busy(e.currentTarget, () => move(i, -1).catch((err) => toast(err.message, true))) }, "▲"),
        h("button", { type: "button", class: "btn-sm", disabled: i === state.platforms.length - 1, "aria-label": "Move down", onclick: (e) => busy(e.currentTarget, () => move(i, 1).catch((err) => toast(err.message, true))) }, "▼")),
      h("div", {},
        h("label", { class: "fld" }, h("span", {}, "Name"), pName),
        h("label", { class: "fld" }, h("span", {}, "Authorized URL"), pUrl),
        h("div", { class: "row-actions", style: "align-items:center" }, h("label", { class: "check" }, vis, "Visible"), saveP, del)),
    ));
  });
  return [heading, add, list];
}

/* ---------- General ---------- */
function renderGeneral() {
  const general = settingsCard("general", "GENERAL SETTINGS", [
    { k: "siteTitle", label: "Browser title" },
    { k: "metaDescription", label: "Search description", type: "textarea" },
    { k: "footerNote", label: "Extra footer line (optional)" },
    { k: "splashEnabled", label: "Show startup splash screen", type: "bool" },
  ]);
  const login = settingsCard("login", "MEMBER LOGIN TEXT", [
    { k: "heading", label: "Heading" },
    { k: "tagline", label: "Tagline" },
  ]);

  const pw = h("form", { class: "card", novalidate: true });
  const cur = h("input", { type: "password", autocomplete: "current-password" });
  const next = h("input", { type: "password", autocomplete: "new-password" });
  const conf = h("input", { type: "password", autocomplete: "new-password" });
  const btn = h("button", { class: "btn-gold", type: "submit" }, h("span", { class: "btn-label" }, "CHANGE PASSWORD"), h("span", { class: "spinner" }));
  pw.append(h("h2", {}, "ADMIN PASSWORD"),
    h("p", { class: "section-note" }, "Changing the password signs out every other admin session."),
    h("label", { class: "fld" }, h("span", {}, "Current password"), cur),
    h("label", { class: "fld" }, h("span", {}, "New password (min 8 characters)"), next),
    h("label", { class: "fld" }, h("span", {}, "Confirm new password"), conf), btn);
  pw.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(btn, async () => {
      try {
        await api("auth/change-password", { method: "POST", body: { current: cur.value, password: next.value, confirm: conf.value } });
        pw.reset();
        toast("Password changed.");
      } catch (err) { toast(err.message, true); }
    });
  });

  const sms = h("div", { class: "card" }, h("h2", {}, "SMS OTP (FORGOT PASSWORD)"),
    h("div", { class: "notice" }, smsConfigured
      ? "SMS OTP is configured. Forgot Password sends a real OTP to the registered admin phone."
      : "SMS OTP is NOT configured yet. To enable Forgot Password, add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID in Netlify → Project configuration → Environment variables, then redeploy."));
  return [general, login, pw, sms];
}

/* ---------------- Boot ---------------- */
let smsConfigured = false;
(async () => {
  try {
    const me = await api("auth/me");
    smsConfigured = me.smsConfigured;
    if (me.authenticated) return await openDashboard();
  } catch {}
  showAuth("login");
})();
