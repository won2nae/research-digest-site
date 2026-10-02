// passphrase로만 복호화되는 정적 브리핑 사이트 공용 스크립트.
// 서버가 없으니 진짜 로그인이 아니라 "콘텐츠 자체를 암호화해서 배포"하는 방식.
// passphrase를 모르면 view-source로도 평문이 안 나온다.
(function () {
  const SESSION_KEY = "briefing-passphrase";

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function deriveKey(passphrase, saltB64) {
    const enc = new TextEncoder();
    const salt = b64ToBytes(saltB64);
    const baseKey = await crypto.subtle.importKey(
      "raw", enc.encode(passphrase), { name: "PBKDF2" }, false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
      baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
    );
  }

  async function tryDecrypt(passphrase, encrypted) {
    try {
      const key = await deriveKey(passphrase, encrypted.salt);
      const iv = b64ToBytes(encrypted.iv);
      const ct = b64ToBytes(encrypted.ct);
      const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
      return JSON.parse(new TextDecoder().decode(plainBuf));
    } catch (e) {
      return null;
    }
  }

  function renderDay(data) {
    const app = document.getElementById("app");
    const tabButtons = data.tabs
      .map((t, i) => `<button class="tab-btn" aria-selected="${i === 0}" data-i="${i}">${t.title}</button>`)
      .join("");
    const panels = data.tabs
      .map((t, i) => `<section class="panel ${i === 0 ? "active" : ""}" data-i="${i}">${marked.parse(t.md)}</section>`)
      .join("");
    app.innerHTML = `
      <div class="wrap">
        <div class="eyebrow">데일리 리서치 브리핑</div>
        <h1 class="page-title">${data.date}</h1>
        <div class="shock">${marked.parse(data.shock_md)}</div>
        <nav class="tabs">${tabButtons}</nav>
        ${panels}
      </div>`;
    app.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        app.querySelectorAll(".tab-btn").forEach((b) => b.setAttribute("aria-selected", b === btn));
        app.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.dataset.i === btn.dataset.i));
      });
    });
  }

  function renderIndex(data) {
    const app = document.getElementById("app");
    const items = data.dates
      .map((d) => `<a href="days/${d}/"><span>${d}</span><span class="arrow">→</span></a>`)
      .join("");
    app.innerHTML = `
      <div class="wrap">
        <div class="eyebrow">리서치 브리핑</div>
        <h1 class="page-title">아카이브</h1>
        <div class="archive-list">${items}</div>
      </div>`;
  }

  function showApp(data, pageKind) {
    document.getElementById("gate").hidden = true;
    const app = document.getElementById("app");
    app.hidden = false;
    if (pageKind === "day") renderDay(data);
    else renderIndex(data);
  }

  const Site = {
    async init(pageKind) {
      const encrypted = JSON.parse(document.getElementById("__DATA__").textContent);
      const form = document.getElementById("gate-form");
      const input = document.getElementById("gate-input");
      const error = document.getElementById("gate-error");

      let cached = null;
      try { cached = sessionStorage.getItem(SESSION_KEY); } catch (e) {}
      if (cached) {
        const data = await tryDecrypt(cached, encrypted);
        if (data) { showApp(data, pageKind); return; }
      }

      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const passphrase = input.value.trim().replace(/^["']|["']$/g, "");
        const data = await tryDecrypt(passphrase, encrypted);
        if (data) {
          try { sessionStorage.setItem(SESSION_KEY, passphrase); } catch (e) {}
          showApp(data, pageKind);
        } else {
          error.hidden = false;
          input.value = "";
          input.focus();
        }
      });
    },
  };

  window.Site = Site;
})();
