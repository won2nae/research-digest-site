// passphrase로만 복호화되는 정적 브리핑 사이트 공용 스크립트.
// 서버가 없으니 진짜 로그인이 아니라 "콘텐츠 자체를 암호화해서 배포"하는 방식.
// passphrase를 모르면 view-source로도 평문이 안 나온다.
(function () {
  const SESSION_KEY = "briefing-passphrase";
  const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

  const FORMAT = {
    KOSPI: (v) => num(v, 2),
    KOSDAQ: (v) => num(v, 2),
    FX_USDKRW: (v) => num(v, 2) + "원",
    CLcv1: (v) => "$" + num(v, 2),
    GCcv1: (v) => "$" + num(v, 2),
    "US10YT=RR": (v) => num(v, 3) + "%",
    "KR10YT=RR": (v) => num(v, 3) + "%",
    ".DJI": (v) => num(v, 2),
    ".INX": (v) => num(v, 2),
    ".IXIC": (v) => num(v, 2),
  };
  const INDEX_CODES = ["KOSPI", "KOSDAQ", ".INX", ".IXIC", ".DJI"];
  const RATE_CODES = ["KR10YT=RR", "US10YT=RR"];
  const SERIES_COLORS = ["#0B6E63", "#D98C2B", "#5B7DB1", "#B5485D", "#7A8B99"];

  let charts = [];
  let lastRender = null;

  function num(v, digits) {
    return Number(v).toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function changeText(ind) {
    const sign = ind.change > 0 ? "+" : "";
    return ind.unit === "bp" ? `${sign}${num(ind.change, 1)}bp` : `${sign}${num(ind.change, 2)}%`;
  }

  function changeClass(ind) {
    return ind.change > 0 ? "up" : ind.change < 0 ? "down" : "flat";
  }

  function valueText(code, ind) {
    const f = FORMAT[code];
    return f ? f(ind.value) : num(ind.value, 2);
  }

  function renderMd(md) {
    // marked 로드 실패 등 예상 못한 상황에서도 빈 화면 대신 원문 텍스트는 보이게.
    try {
      if (window.marked) return marked.parse(md);
    } catch (e) {}
    const div = document.createElement("div");
    div.textContent = md;
    return `<pre style="white-space:pre-wrap;font-family:inherit">${div.innerHTML}</pre>`;
  }

  function destroyCharts() {
    charts.forEach((c) => c.destroy());
    charts = [];
  }

  function statGrid(market) {
    if (!market) return "";
    const cards = Object.entries(market)
      .map(([code, ind]) => `
        <div class="stat">
          <div class="stat-label">${esc(ind.label)}</div>
          <div class="stat-value num">${esc(valueText(code, ind))}</div>
          <div class="stat-change num ${changeClass(ind)}">${esc(changeText(ind))}</div>
        </div>`)
      .join("");
    return `<div class="stat-grid">${cards}</div>`;
  }

  function lineChart(canvas, labels, datasets) {
    const muted = token("--ink-muted");
    const grid = token("--border");
    return new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: datasets.map((d, i) => ({
          label: d.label,
          data: d.data,
          borderColor: SERIES_COLORS[i % SERIES_COLORS.length],
          backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length],
          tension: 0.3,
          pointRadius: 2.5,
          pointHoverRadius: 5,
          borderWidth: 2,
          spanGaps: true,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom", labels: { color: muted, boxWidth: 12, usePointStyle: true } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 12 } },
          y: { grid: { color: grid }, ticks: { color: muted } },
        },
      },
    });
  }

  function barChart(canvas, labels, values) {
    const up = token("--up");
    const down = token("--down");
    const muted = token("--ink-muted");
    const ink = token("--ink");
    const grid = token("--border");
    return new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: values.map((v) => (v >= 0 ? up : down)),
          borderRadius: 4,
          barThickness: 16,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${c.raw >= 0 ? "+" : ""}${c.raw.toFixed(2)}%` } },
        },
        scales: {
          x: { grid: { color: grid }, ticks: { color: muted, callback: (v) => v + "%" } },
          y: { grid: { display: false }, ticks: { color: ink } },
        },
      },
    });
  }

  function dayMarketBlock(market) {
    if (!market) return "";
    const pctEntries = Object.entries(market).filter(([, ind]) => ind.unit === "%");
    const hasBars = pctEntries.length > 0;
    return `
      <section class="market-block">
        <div class="block-head"><h2>오늘의 시장</h2><span class="muted">전일 대비</span></div>
        ${statGrid(market)}
        ${hasBars ? `<div class="chart-card"><h3>전일 대비 변동률</h3><div class="chart-box tall"><canvas id="day-bar"></canvas></div></div>` : ""}
      </section>`;
  }

  function renderDay(data) {
    const app = document.getElementById("app");
    const tabButtons = data.tabs
      .map((t, i) => `<button class="tab-btn" aria-selected="${i === 0}" data-i="${i}">${esc(t.title)}</button>`)
      .join("");
    const panels = data.tabs
      .map((t, i) => `<section class="panel ${i === 0 ? "active" : ""}" data-i="${i}">${renderMd(t.md)}</section>`)
      .join("");
    app.innerHTML = `
      <div class="wrap">
        <a class="back" href="../../">← 아카이브</a>
        <header class="page-head">
          <div class="eyebrow">데일리 리서치 브리핑</div>
          <h1>${esc(data.date)}</h1>
        </header>
        ${dayMarketBlock(data.market)}
        ${data.shock_md ? `<div class="shock">${renderMd(data.shock_md)}</div>` : ""}
        <nav class="tabs">${tabButtons}</nav>
        ${panels}
      </div>`;

    app.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        app.querySelectorAll(".tab-btn").forEach((b) => b.setAttribute("aria-selected", b === btn));
        app.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.dataset.i === btn.dataset.i));
      });
    });

    destroyCharts();
    const bar = document.getElementById("day-bar");
    if (bar && data.market) {
      const pct = Object.values(data.market).filter((ind) => ind.unit === "%");
      charts.push(barChart(bar, pct.map((i) => i.label), pct.map((i) => i.change)));
    }
  }

  function renderIndex(data) {
    const app = document.getElementById("app");
    const days = [...data.days].sort((a, b) => b.date.localeCompare(a.date));
    const asc = [...days].reverse();
    const latest = days[0];
    const labels = asc.map((d) => d.date.slice(5).replace("-", "."));

    const indexSeries = INDEX_CODES.map((code) => {
      const base = asc.map((d) => d.market?.[code]?.value).find((v) => v != null);
      return {
        label: asc.find((d) => d.market?.[code])?.market[code].label || code,
        data: asc.map((d) => {
          const v = d.market?.[code]?.value;
          return v == null || !base ? null : Math.round((v / base) * 1000) / 10;
        }),
      };
    });
    const rateSeries = RATE_CODES.map((code) => ({
      label: asc.find((d) => d.market?.[code])?.market[code].label || code,
      data: asc.map((d) => d.market?.[code]?.value ?? null),
    }));

    const byMonth = {};
    days.forEach((d) => {
      const m = d.date.slice(0, 7);
      (byMonth[m] ||= []).push(d);
    });
    const archive = Object.keys(byMonth)
      .sort((a, b) => b.localeCompare(a))
      .map((m) => {
        const cards = byMonth[m]
          .map((d) => {
            const wd = WEEKDAYS[new Date(d.date + "T00:00:00").getDay()];
            const kospi = d.market?.KOSPI;
            const chip = kospi
              ? `<span class="chip ${changeClass(kospi)} num">코스피 ${esc(changeText(kospi))}</span>`
              : "";
            return `
              <a class="day-card" href="days/${d.date}/">
                <div class="day-top"><span class="day-num num">${d.date.slice(8)}</span><span class="day-wd">${wd}</span></div>
                <p class="day-head">${esc(d.headline || "요약 없음")}</p>
                ${chip}
              </a>`;
          })
          .join("");
        const [y, mo] = m.split("-");
        return `<section class="month"><h2>${y}년 ${Number(mo)}월</h2><div class="day-grid">${cards}</div></section>`;
      })
      .join("");

    const pctEntries = latest ? Object.entries(latest.market || {}).filter(([, ind]) => ind.unit === "%") : [];

    app.innerHTML = `
      <div class="wrap wide">
        <header class="hero">
          <div class="eyebrow">데일리 리서치 브리핑</div>
          <h1>시장 브리핑</h1>
          <p class="sub">${latest ? esc(latest.date) + " 기준 · " : ""}주말·공휴일 제외</p>
        </header>

        ${latest ? `
        <section class="block">
          <div class="block-head"><h2>최근 영업일 시장</h2><span class="muted">${esc(latest.date)} 종가</span></div>
          ${statGrid(latest.market)}
        </section>

        <section class="block charts">
          <div class="chart-card span2">
            <h3>지수 흐름 <span class="muted">· 첫 영업일 = 100</span></h3>
            <div class="chart-box"><canvas id="idx-chart"></canvas></div>
          </div>
          <div class="chart-card">
            <h3>금리 추이 <span class="muted">· %</span></h3>
            <div class="chart-box"><canvas id="rate-chart"></canvas></div>
          </div>
          <div class="chart-card">
            <h3>전일 대비 변동률 <span class="muted">· ${esc(latest.date.slice(5))}</span></h3>
            <div class="chart-box"><canvas id="bar-chart"></canvas></div>
          </div>
        </section>` : ""}

        <section class="block">
          <div class="block-head"><h2>아카이브</h2><span class="muted">${days.length}개 영업일</span></div>
          ${archive}
        </section>
      </div>`;

    destroyCharts();
    if (!latest) return;
    const idx = document.getElementById("idx-chart");
    const rate = document.getElementById("rate-chart");
    const bar = document.getElementById("bar-chart");
    charts.push(lineChart(idx, labels, indexSeries));
    charts.push(lineChart(rate, labels, rateSeries));
    charts.push(barChart(bar, pctEntries.map(([, i]) => i.label), pctEntries.map(([, i]) => i.change)));
  }

  function showApp(data, pageKind) {
    const gate = document.getElementById("gate");
    if (gate) gate.hidden = true;
    const app = document.getElementById("app");
    app.hidden = false;
    lastRender = () => (pageKind === "day" ? renderDay(data) : renderIndex(data));
    lastRender();
  }

  const Site = {
    async init(pageKind) {
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => lastRender && lastRender());
      const raw = JSON.parse(document.getElementById("__DATA__").textContent);

      // 게이트가 꺼진(공개) 빌드: __DATA__가 그냥 평문이라 바로 렌더링.
      if (!(raw && raw.salt && raw.iv && raw.ct)) {
        showApp(raw, pageKind);
        return;
      }
      const encrypted = raw;

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

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  window.Site = Site;
})();
