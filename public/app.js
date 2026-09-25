const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let authMode = "register";
let currentMode = "text";
let pollTimer = null;

const authView = $("#authView");
const appView = $("#appView");

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

function showAuth(mode = authMode) {
  authMode = mode;
  authView.classList.remove("hidden");
  appView.classList.add("hidden");

  $("#nameField").classList.toggle("hidden", mode !== "register");

  $("#authTitle").textContent =
    mode === "register"
      ? "Create cinematic videos from an idea."
      : "Welcome back to your studio.";

  $("#authSub").textContent =
    mode === "register"
      ? "Generate with text, animate an image, and keep every creation in your personal studio."
      : "Sign in to continue creating.";

  $("#authButton").textContent =
    mode === "register" ? "Create account" : "Log in";

  $("#authSwitch").textContent =
    mode === "register"
      ? "Already have an account? Log in"
      : "Need an account? Create one";

  $("#password").autocomplete =
    mode === "register" ? "new-password" : "current-password";

  $("#authError").textContent = "";
}

async function api(url, options = {}) {
  const res = await fetch(url, options);

  let data = {};
  try {
    data = await res.json();
  } catch {}

  if (!res.ok) {
    throw new Error(data.error || "Something went wrong.");
  }

  return data;
}

async function bootstrap() {
  try {
    const data = await api("/api/me");

    if (data.user) {
      openApp(data.user);
      await loadDashboard();
    } else {
      showAuth("register");
    }
  } catch {
    showAuth("register");
  }
}

function openApp(user) {
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  updateUser(user);
}

function updateUser(user) {
  $("#sideCredits").textContent = user.credits;
  $("#miniCredits").textContent = user.credits;
  $("#profileName").textContent = user.name;
  $("#profileEmail").textContent = user.email;
  $("#avatar").textContent = user.name.charAt(0).toUpperCase();
}

$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  $("#authError").textContent = "";

  const body = {
    name: $("#name").value,
    email: $("#email").value,
    password: $("#password").value
  };

  try {
    const data = await api(
      authMode === "register"
        ? "/api/auth/register"
        : "/api/auth/login",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    openApp(data.user);
    await loadDashboard();

    toast(
      authMode === "register"
        ? "Account created."
        : "Welcome back."
    );
  } catch (error) {
    $("#authError").textContent = error.message;
  }
});

$("#authSwitch").addEventListener("click", () => {
  showAuth(authMode === "register" ? "login" : "register");
});

$("#logout").addEventListener("click", async () => {
  await api("/api/auth/logout", {
    method: "POST"
  });

  clearInterval(pollTimer);
  showAuth("login");
});

$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    switchView(btn.dataset.view);
  });
});

function switchView(view) {
  const studio = view === "studio";

  $("#studioView").classList.toggle("hidden", !studio);
  $("#historyView").classList.toggle("hidden", studio);

  $$(".nav-item").forEach((n) => {
    n.classList.toggle(
      "active",
      n.dataset.view === view
    );
  });

  $("#viewTitle").textContent =
    studio ? "Studio" : "My videos";

  $("#viewSub").textContent =
    studio
      ? "Create your next scene."
      : "Your generation history.";

  if (!studio) {
    renderHistory();
  }

  $(".sidebar").classList.remove("open");
}

$("#mobileMenu").addEventListener("click", () => {
  $(".sidebar").classList.toggle("open");
});

$$(".mode").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentMode = btn.dataset.mode;

    $$(".mode").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });

    $("#uploadArea").classList.toggle(
      "hidden",
      currentMode !== "image"
    );
  });
});

$("#prompt").addEventListener("input", () => {
  $("#count").textContent =
    `${$("#prompt").value.length} / 2000`;
});

$("#duration").addEventListener("change", updateCost);

function updateCost() {
  const cost = Number($("#duration").value) * 12;
  $("#cost").textContent = `${cost} credits`;
}

updateCost();

$("#image").addEventListener("change", () => {
  const file = $("#image").files[0];

  if (!file) return;

  const preview = $("#imagePreview");

  preview.src = URL.createObjectURL(file);
  preview.classList.remove("hidden");
});

$("#generateForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  $("#generateError").textContent = "";

  const prompt = $("#prompt").value.trim();

  if (prompt.length < 3) {
    $("#generateError").textContent =
      "Describe what you want to generate.";
    return;
  }

  const duration = Number($("#duration").value);
  const charge = duration * 12;
  const image = $("#image").files[0];

  if (currentMode === "image" && !image) {
    $("#generateError").textContent =
      "Choose an image first.";
    return;
  }

  const btn = $("#generateButton");

  btn.disabled = true;
  btn.querySelector("span").textContent = "Starting...";

  try {
    const form = new FormData();

    form.append("prompt", prompt);
    form.append("duration", duration);
    form.append("ratio", $("#ratio").value);

    if (currentMode === "image") {
      form.append("image", image);
    }

    const data = await api("/api/videos", {
      method: "POST",
      body: form
    });

    updateUser({
      ...getDisplayedUser(),
      credits: data.creditsRemaining
    });

    showProgress(data.id, charge);
  } catch (error) {
    $("#generateError").textContent = error.message;
  } finally {
    btn.disabled = false;
    btn.querySelector("span").textContent =
      "Generate video";
  }
});

function getDisplayedUser() {
  return {
    name: $("#profileName").textContent,
    email: $("#profileEmail").textContent,
    credits: Number($("#sideCredits").textContent)
  };
}

function showProgress(taskId, charge) {
  $("#previewStage .preview-empty").classList.add("hidden");
  $("#progressBox").classList.remove("hidden");
  $("#video").classList.add("hidden");
  $("#resultActions").classList.add("hidden");

  $("#statusDot").classList.add("busy");
  $("#previewStatus").textContent =
    `Generating · ${charge} credits`;

  $("#progressTitle").textContent =
    "Creating your video...";

  $("#progressText").textContent =
    "The model is rendering your scene. You can stay on this page.";

  clearInterval(pollTimer);

  pollTimer = setInterval(
    () => poll(taskId),
    5000
  );

  poll(taskId);
}

async function poll(taskId) {
  try {
    const data = await api(
      `/api/videos/${encodeURIComponent(taskId)}`
    );

    updateUser({
      ...getDisplayedUser(),
      credits: data.credits
    });

    if (data.status === "SUCCEEDED") {
      clearInterval(pollTimer);

      $("#progressBox").classList.add("hidden");

      $("#video").src = data.video_url;
      $("#video").classList.remove("hidden");

      $("#openVideo").href = data.video_url;
      $("#resultActions").classList.remove("hidden");

      $("#statusDot").classList.remove("busy");
      $("#previewStatus").textContent = "Ready";

      toast("Your video is ready.");

      await loadDashboard();
      return;
    }

    if (
      data.status === "FAILED" ||
      data.status === "CANCELED"
    ) {
      clearInterval(pollTimer);

      $("#progressBox").classList.add("hidden");

      $("#previewStage .preview-empty")
        .classList.remove("hidden");

      $("#statusDot").classList.remove("busy");

      $("#previewStatus").textContent =
        "Generation failed";

      $("#generateError").textContent =
        "The generation did not complete. Your app credits were refunded.";

      await loadDashboard();
      return;
    }

    $("#progressText").textContent =
      `Status: ${data.status.toLowerCase()}. Still working...`;
  } catch (error) {
    clearInterval(pollTimer);

    $("#generateError").textContent =
      error.message;

    $("#statusDot").classList.remove("busy");
  }
}

$("#newVideo").addEventListener("click", () => {
  $("#video").classList.add("hidden");
  $("#resultActions").classList.add("hidden");

  $("#previewStage .preview-empty")
    .classList.remove("hidden");

  $("#previewStatus").textContent =
    "Ready to create";

  $("#generateError").textContent = "";

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
});

async function loadDashboard() {
  try {
    const data = await api("/api/dashboard");

    updateUser(data.user);

    $("#statTotal").textContent =
      data.stats.total;

    $("#statCompleted").textContent =
      data.stats.completed;

    $("#statProcessing").textContent =
      data.stats.processing;

    $("#statUsed").textContent =
      data.stats.creditsUsed;

    renderHistory(data.history);
  } catch (error) {
    if (
      error.message
        .toLowerCase()
        .includes("log in")
    ) {
      showAuth("login");
    }
  }
}

let cachedHistory = [];

function renderHistory(history = cachedHistory) {
  cachedHistory = history;

  const grid = $("#historyGrid");

  if (!history.length) {
    grid.innerHTML = `
      <div class="panel"
        style="grid-column:1/-1;text-align:center;padding:50px">

        <div class="play-orb"
          style="margin:0 auto 15px">
          ✦
        </div>

        <strong>No videos yet</strong>

        <p style="color:#687184;font-size:12px">
          Your generations will show up here.
        </p>
      </div>
    `;

    return;
  }

  grid.innerHTML = history.map(item => {
    const prompt = escapeHtml(item.prompt);

    const thumb = item.video_url
      ? `<video
          src="${escapeAttr(item.video_url)}"
          controls
          muted
          playsinline>
        </video>`
      : `<div class="pending">
          ${escapeHtml(item.status)}
        </div>`;

    return `
      <article class="history-card">

        <div class="history-thumb">
          ${thumb}
        </div>

        <div class="history-info">

          <strong title="${prompt}">
            ${prompt}
          </strong>

          <div class="history-meta">
            <span>${item.mode}</span>
            <span>
              ${item.duration}s ·
              ${item.credits_charged} credits
            </span>
          </div>

          <button
            class="history-delete"
            data-delete="${item.id}">
            Delete from history
          </button>

        </div>

      </article>
    `;
  }).join("");

  $$("[data-delete]").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        await api(
          `/api/videos/${btn.dataset.delete}`,
          {
            method: "DELETE"
          }
        );

        await loadDashboard();

        toast("Removed from history.");
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[ch])
  );
}

function escapeAttr(value) {
  return escapeHtml(value);
}

bootstrap();
