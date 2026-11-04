// 공개 채팅 페이지 전용 스크립트. site.js의 렌더링 유틸과는 분리해서 가볍게 유지.
(function () {
  const HISTORY_KEY = "briefing-chat-history";

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderMd(md) {
    try {
      if (window.marked) return marked.parse(md);
    } catch (e) {}
    const div = document.createElement("div");
    div.textContent = md;
    return `<pre style="white-space:pre-wrap;font-family:inherit">${div.innerHTML}</pre>`;
  }

  function loadHistory() {
    try {
      return JSON.parse(sessionStorage.getItem(HISTORY_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function saveHistory(history) {
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {}
  }

  function addBubble(log, role, html) {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${role}`;
    bubble.innerHTML = html;
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  function init() {
    const log = document.getElementById("chat-log");
    const form = document.getElementById("chat-form");
    const input = document.getElementById("chat-input");
    const sendBtn = document.getElementById("chat-send");
    if (!log || !form || !input) return;

    let history = loadHistory();
    for (const turn of history) {
      addBubble(log, turn.role === "user" ? "user" : "assistant", turn.role === "user" ? esc(turn.content) : renderMd(turn.content));
    }

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const message = input.value.trim();
      if (!message) return;
      input.value = "";
      input.disabled = true;
      sendBtn.disabled = true;

      addBubble(log, "user", esc(message));
      const thinking = addBubble(log, "assistant thinking", "생각 중…");

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, history }),
        });
        const data = await res.json();
        thinking.remove();
        if (!res.ok) {
          addBubble(log, "assistant error", esc(data.error || "오류가 발생했어요."));
        } else {
          addBubble(log, "assistant", renderMd(data.answer));
          history.push({ role: "user", content: message });
          history.push({ role: "assistant", content: data.answer });
          history = history.slice(-20);
          saveHistory(history);
        }
      } catch (e) {
        thinking.remove();
        addBubble(log, "assistant error", "네트워크 오류로 답변을 못 받았어요.");
      } finally {
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
