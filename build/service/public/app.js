// AVADO Care status page. Plain JS, no dependencies; loaded under a strict CSP (script-src 'self').
(function () {
  "use strict";

  // Theme: ?theme=light|dark (e.g. when the Admin embeds the page), else the system setting; dark is the AVADO default.
  var params = new URLSearchParams(location.search);
  var theme = params.get("theme");
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", theme);

  var REFRESH_MS = 30 * 1000;
  var status = null;

  function $(id) {
    return document.getElementById(id);
  }

  function ago(iso) {
    if (!iso) return "Not yet";
    var s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (!isFinite(s)) return "Not yet";
    if (s < 60) return "Just now";
    var m = Math.round(s / 60);
    if (m < 60) return m === 1 ? "1 minute ago" : m + " minutes ago";
    var h = Math.round(m / 60);
    if (h < 48) return h === 1 ? "1 hour ago" : h + " hours ago";
    var d = Math.round(h / 24);
    return d + " days ago";
  }

  function until(iso) {
    if (!iso) return "In a few minutes";
    var s = Math.round((Date.parse(iso) - Date.now()) / 1000);
    if (!isFinite(s) || s <= 30) return "Any moment now";
    var m = Math.round(s / 60);
    return m <= 1 ? "In about a minute" : "In about " + m + " minutes";
  }

  function headline(s) {
    var watching = s.subscribed === true ? "AVADO is watching your box" : "Your AVADO checks itself every 10 minutes";
    if (s.checking && !s.lastCheckAt) return [watching, "Checking your AVADO…"];
    if (s.heartbeatIssue === "outdated") {
      return ["Waiting for a system update", "Your AVADO checks itself. It starts reporting to AVADO after its next system update."];
    }
    if (!s.lastHeartbeat.ok && s.lastHeartbeat.at) {
      return ["AVADO can't hear from your box right now", "Your AVADO checked itself, but could not tell AVADO. See below."];
    }
    switch (s.verdict) {
      case "ok":
        return [watching, "Everything looks good."];
      case "warning":
        return [watching, "Something needs your attention. See the problems below."];
      case "critical":
        return [watching, "Action required: see the problems below."];
      default:
        return [watching, "Checking your AVADO…"];
    }
  }

  function careText(s) {
    if (s.subscribed === true) return "Active";
    if (s.subscribed === false) return "Not active";
    return "Not known yet";
  }

  function emailText(s) {
    if (s.subscribed === true && s.emailVerified === true) return "On";
    if (s.subscribed === true) return "Confirm your email in the Admin under Priority";
    if (s.subscribed === false) return "Off: turn on Priority Care in the Admin";
    return "Not known yet";
  }

  function render(s) {
    status = s;
    $("version").textContent = s.version ? "v" + s.version : "";
    var h = headline(s);
    $("headline").textContent = h[0];
    $("subline").textContent = h[1];
    var level = s.heartbeatIssue === "outdated" ? s.verdict : !s.lastHeartbeat.ok && s.lastHeartbeat.at ? "warning" : s.verdict;
    $("verdict").setAttribute("data-level", level);
    $("last-check").textContent = ago(s.lastCheckAt);
    $("next-check").textContent = s.checking ? "Checking now…" : until(s.nextCheckAt);
    $("care").textContent = careText(s);
    $("subscription").textContent = emailText(s);

    var notice = $("check-notice");
    notice.textContent = s.notice || "";
    notice.hidden = !s.notice;

    var err = $("heartbeat-error");
    if (s.lastHeartbeat.error && s.heartbeatIssue !== "outdated") {
      err.textContent = s.lastHeartbeat.error;
      err.hidden = false;
    } else {
      err.hidden = true;
    }

    var list = $("problems");
    while (list.firstChild) list.removeChild(list.firstChild);
    var problems = (s.findings || []).filter(function (f) {
      return f.severity === "critical" || f.severity === "warning";
    });
    problems.forEach(function (f) {
      var li = document.createElement("li");
      li.setAttribute("data-severity", f.severity);
      var title = document.createElement("div");
      title.className = "title";
      var lvl = document.createElement("span");
      lvl.className = "level";
      lvl.textContent = f.severity === "critical" ? "Urgent" : "Attention";
      title.appendChild(lvl);
      title.appendChild(document.createTextNode(f.title));
      li.appendChild(title);
      if (f.why) {
        var why = document.createElement("div");
        why.className = "why";
        why.textContent = f.why;
        li.appendChild(why);
      }
      list.appendChild(li);
    });
    $("no-problems").hidden = problems.length > 0;
    $("no-problems").textContent = s.lastCheckAt ? "No problems found." : "The first check runs shortly after AVADO Care starts.";
  }

  function load() {
    return fetch("/api/status", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(render)
      .catch(function () {
        $("subline").textContent = "This page could not reach AVADO Care. It retries on its own.";
      });
  }

  function checkNow() {
    var btn = $("check-now");
    var msg = $("check-now-msg");
    btn.disabled = true;
    msg.textContent = "Checking… this can take a minute.";
    fetch("/api/check-now", { method: "POST", headers: { "X-Avado-Request": "1" } })
      .then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) throw new Error(body && body.error ? body.error : "The check did not run. Please try again.");
          return body;
        });
      })
      .then(function (s) {
        render(s);
        msg.textContent = s.checking ? "Still checking… this page updates by itself." : "Done.";
        if (s.checking) pollUntilDone();
      })
      .catch(function (e) {
        msg.textContent = e.message;
      })
      .then(function () {
        btn.disabled = false;
      });
  }

  function pollUntilDone() {
    setTimeout(function () {
      load().then(function () {
        if (status && status.checking) pollUntilDone();
        else $("check-now-msg").textContent = "Done.";
      });
    }, 5000);
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("check-now").addEventListener("click", checkNow);
    load();
    setInterval(load, REFRESH_MS);
    // keep "x minutes ago" fresh between refreshes
    setInterval(function () {
      if (status) render(status);
    }, 15 * 1000);
  });
})();
