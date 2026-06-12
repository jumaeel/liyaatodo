/* ============================================================
   Liyaatodo · Daily Progress Dashboard
   Vanilla JS · LocalStorage persistence
   ============================================================ */

(() => {
  'use strict';

  const STORAGE_KEY = 'momentum.state.v1';

  /* ---------- State ---------- */
  let state = {
    projects: [],        // { id, name }
    tasks: [],           // { id, projectId, title, priority, deadline, isCompleted, urgent, important }
    activeProjectId: null,
    todayTaskIds: [],    // up to 5 task IDs selected for today
    user: { name: '' },  // the person using the app
  };
  let filter = 'all';    // all | active | done
  let view   = 'list';   // list | matrix
  let screen = 'dashboard'; // dashboard | today | project

  /* ---------- Utilities ---------- */
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  let _seq = 0;
  const uid = () => `${Date.now().toString(36)}-${(_seq++).toString(36)}-${performance.now().toString(36).replace('.', '')}`;

  const escapeHTML = (str) =>
    String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

  /* ---------- Time estimates ---------- */
  // Parse "30m", "2h", "1h30m", "1.5h", "90" → minutes (or null).
  function parseEstimate(input) {
    if (input == null) return null;
    const s = String(input).trim().toLowerCase();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) {            // bare number = minutes
      const n = Math.round(parseFloat(s));
      return n > 0 ? n : null;
    }
    let total = 0, matched = false;
    const h = s.match(/(\d+(?:\.\d+)?)\s*h/);
    const m = s.match(/(\d+(?:\.\d+)?)\s*m/);
    if (h) { total += parseFloat(h[1]) * 60; matched = true; }
    if (m) { total += parseFloat(m[1]);       matched = true; }
    if (!matched) return null;
    total = Math.round(total);
    return total > 0 ? total : null;
  }

  // minutes → "1h 30m" / "45m" / "2h"
  function formatEstimate(min) {
    if (!min || min <= 0) return '';
    const h = Math.floor(min / 60), m = min % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
  }

  // Small inline clock badge for a task's estimate (empty string if none).
  const estBadge = (task) => task.estimateMin
    ? `<span class="est"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${escapeHTML(formatEstimate(task.estimateMin))}</span>`
    : '';

  // Sum estimate minutes over a list of tasks.
  const sumEstimate = (tasks) => tasks.reduce((s, t) => s + (t.estimateMin || 0), 0);

  /* ---------- Persistence ---------- */
  // Local write only.
  function saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.error('Failed to save state:', err);
      toast('⚠️ Could not save — storage may be full');
    }
  }

  // Every mutation calls this: persist locally AND (if signed in) to the cloud.
  function save() {
    saveLocal();
    queueCloudPush();
  }

  // Replace the in-memory state from a parsed object (local OR cloud), then
  // normalize/migrate it. Does NOT write anything.
  function setStateFrom(parsed) {
    if (parsed && Array.isArray(parsed.projects) && Array.isArray(parsed.tasks)) {
      state = {
        projects: parsed.projects,
        tasks: parsed.tasks,
        activeProjectId: parsed.activeProjectId ?? null,
        todayTaskIds: Array.isArray(parsed.todayTaskIds) ? parsed.todayTaskIds : [],
        user: parsed.user && typeof parsed.user.name === 'string' ? parsed.user : { name: '' },
      };
    }
    normalizeState();
  }

  function normalizeState() {
    // Seed the default "General" project when there are none.
    if (state.projects.length === 0) {
      const general = { id: uid(), name: 'General' };
      state.projects.push(general);
      state.activeProjectId = general.id;
    }
    // Guarantee a valid active project.
    if (!state.projects.some((p) => p.id === state.activeProjectId)) {
      state.activeProjectId = state.projects[0]?.id ?? null;
    }
    // Migrate older tasks that predate the Eisenhower fields.
    state.tasks.forEach((t) => {
      if (typeof t.important !== 'boolean') t.important = t.priority === 'High';
      if (typeof t.urgent !== 'boolean') t.urgent = false;
      if (typeof t.estimateMin !== 'number' || t.estimateMin <= 0) t.estimateMin = null;
    });
    // Clean up stale todayTaskIds.
    const taskIds = new Set(state.tasks.map((t) => t.id));
    state.todayTaskIds = state.todayTaskIds.filter((id) => taskIds.has(id));
  }

  function load() {
    let parsed = null;
    try {
      parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch { parsed = null; }
    setStateFrom(parsed);
    saveLocal();
  }

  /* ============================================================
     CLOUD SYNC  (Firebase Auth + Firestore)
     Signed in → every change is mirrored to users/{uid} and pulled
     back on other devices in real time. Signed out → local only.
     ============================================================ */
  const Cloud = {
    enabled: false,    // config present + SDK loaded + init OK
    db: null,
    user: null,
    unsub: null,       // Firestore listener teardown
    applying: false,   // true while writing remote→local (suppresses echo writes)
    pushTimer: null,
    lastStamp: 0,      // most recent stamp we've written or applied
  };

  function cloudConfigured() {
    const c = window.firebaseConfig;
    return !!(c && typeof c.apiKey === 'string' && !c.apiKey.startsWith('PASTE_'));
  }

  function initCloud() {
    if (!cloudConfigured() || typeof firebase === 'undefined') {
      renderAuth();
      return;
    }
    try {
      firebase.initializeApp(window.firebaseConfig);
      Cloud.db = firebase.firestore();
      Cloud.enabled = true;
      firebase.auth().onAuthStateChanged(onAuthChanged);
    } catch (err) {
      console.error('Firebase init failed:', err);
      Cloud.enabled = false;
    }
    renderAuth();
  }

  function cloudSignIn() {
    if (!Cloud.enabled) { toast('Cloud sign-in is not set up yet'); return; }
    const provider = new firebase.auth.GoogleAuthProvider();
    firebase.auth().signInWithPopup(provider).catch((err) => {
      console.error('Sign-in failed:', err);
      toast('Sign-in failed — ' + (err.code || err.message || 'try again'));
    });
  }

  function cloudSignOut() {
    if (!Cloud.enabled) return;
    firebase.auth().signOut().then(() => toast('Signed out — saved on this device'));
  }

  function onAuthChanged(user) {
    Cloud.user = user;
    if (Cloud.unsub) { Cloud.unsub(); Cloud.unsub = null; }

    if (user) {
      // Adopt the Google first name if the user hasn't set their own.
      if (!state.user.name && user.displayName) {
        state.user.name = user.displayName.split(/\s+/)[0] || user.displayName;
        saveLocal();
      }
      subscribeCloud(user.uid);
      toast('Signed in — your progress is saved to your account ☁️');
    }
    renderAuth();
    renderUser();
  }

  function userDoc(uid) {
    return Cloud.db.collection('users').doc(uid);
  }

  // Listen to the user's cloud document. First snapshot decides the merge:
  //   • no cloud copy yet  → push whatever is local now (protects this device's data)
  //   • cloud copy exists  → pull it (this is the account's source of truth)
  function subscribeCloud(uid) {
    let first = true;
    Cloud.unsub = userDoc(uid).onSnapshot(
      (snap) => {
        const data = snap.data();
        if (first) {
          first = false;
          if (!data || !data.state) { pushToCloud(); return; }
        }
        if (!data || !data.state) return;
        if ((data.stamp || 0) <= Cloud.lastStamp) return; // our own echo / nothing newer
        applyRemoteState(data.state, data.stamp || 0);
      },
      (err) => console.error('Cloud listen error:', err)
    );
  }

  function applyRemoteState(remote, stamp) {
    Cloud.applying = true;
    Cloud.lastStamp = stamp;
    setStateFrom(remote);
    saveLocal();
    render();
    Cloud.applying = false;
  }

  function queueCloudPush() {
    if (!Cloud.enabled || !Cloud.user || Cloud.applying) return;
    setSyncStatus('saving');
    clearTimeout(Cloud.pushTimer);
    Cloud.pushTimer = setTimeout(pushToCloud, 600);
  }

  function pushToCloud() {
    if (!Cloud.enabled || !Cloud.user) return;
    const stamp = Date.now();
    Cloud.lastStamp = stamp;
    const payload = JSON.parse(JSON.stringify(state)); // plain, no undefined
    userDoc(Cloud.user.uid)
      .set({ state: payload, stamp, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
      .then(() => setSyncStatus('saved'))
      .catch((err) => { console.error('Cloud save failed:', err); setSyncStatus('error'); });
  }

  function renderAuth() {
    const unconf = $('#authUnconfigured');
    if (!unconf) return; // modal not in DOM
    const out = $('#authSignedOut');
    const inn = $('#authSignedIn');

    if (!Cloud.enabled) {
      unconf.classList.remove('hidden');
      out.classList.add('hidden');
      inn.classList.add('hidden');
      return;
    }
    unconf.classList.add('hidden');

    if (Cloud.user) {
      out.classList.add('hidden');
      inn.classList.remove('hidden');
      $('#authEmail').textContent = Cloud.user.email || Cloud.user.displayName || 'Signed in';
      $('#authAvatar').textContent = userInitials(Cloud.user.displayName || Cloud.user.email || '?');
      setSyncStatus('saved');
    } else {
      out.classList.remove('hidden');
      inn.classList.add('hidden');
    }
  }

  function setSyncStatus(s) {
    const el = $('#authStatus');
    if (!el) return;
    if (s === 'saving')      { el.textContent = 'Saving…'; el.className = 'text-xs text-slate-400'; }
    else if (s === 'error')  { el.textContent = 'Save failed — will retry on next change'; el.className = 'text-xs text-red-500'; }
    else                     { el.textContent = 'Synced ✓ — saved to your account'; el.className = 'text-xs text-indigo-600'; }
  }

  /* ---------- Date helpers ---------- */
  const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

  // ISO yyyy-mm-dd for a date that's `days` from today (default 7 = one week).
  function defaultDeadline(days = 7) {
    const d = todayStart();
    d.setDate(d.getDate() + days);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function isOverdue(task) {
    if (!task.deadline || task.isCompleted) return false;
    const due = new Date(task.deadline + 'T00:00:00');
    return due < todayStart();
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return '';
    const today = todayStart();
    const diffDays = Math.round((d - today) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    if (diffDays === -1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  /* ---------- Derived data ---------- */
  const activeProject = () => state.projects.find((p) => p.id === state.activeProjectId) || null;
  const tasksFor = (projectId) => state.tasks.filter((t) => t.projectId === projectId);

  /* ============================================================
     SCREEN SWITCHING
     ============================================================ */

  function switchScreen(name) {
    screen = name;
    $('#dashboardScreen').classList.toggle('hidden', name !== 'dashboard');
    $('#todayScreen').classList.toggle('hidden', name !== 'today');
    $('#projectScreen').classList.toggle('hidden', name !== 'project');
    $('#guideScreen').classList.toggle('hidden', name !== 'guide');
    $('#dashboardNav').classList.toggle('is-active', name === 'dashboard');
    $('#todayNav').classList.toggle('is-active', name === 'today');
    $('#guideNav').classList.toggle('is-active', name === 'guide');

    // Search bar only exists while viewing a project.
    const onProject = name === 'project';
    $('#searchWrap').classList.toggle('hidden', !onProject);
    if (!onProject) {
      $('#searchInput').value = '';
      $$('.task-row').forEach((row) => row.style.opacity = '');
    }
    closeSidebar();
  }

  /* ============================================================
     RENDERING
     ============================================================ */

  function render() {
    renderUser();
    renderSidebar();
    if (screen === 'dashboard') renderDashboard();
    if (screen === 'today') renderToday();
    if (screen === 'project') {
      renderHeader();
      renderProgress();
      renderView();
    }
  }

  /* ---------- User ---------- */
  function userInitials(name) {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    return parts.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  }

  function renderUser() {
    const name = state.user.name.trim();
    $('#userAvatar').textContent = name ? userInitials(name) : '?';
    $('#userName').textContent = name || 'Set your name';
    const eyebrow = $('#bannerEyebrow');
    if (eyebrow) {
      eyebrow.textContent = name
        ? `Welcome back, ${name} — your productivity, organized`
        : 'Your productivity, organized';
    }
  }

  function openUserModal() {
    $('#userModal').classList.remove('hidden');
    renderAuth();
    const input = $('#userNameInput');
    input.value = state.user.name;
    setTimeout(() => input.focus(), 50);
  }

  function closeUserModal() {
    $('#userModal').classList.add('hidden');
  }

  function saveUser(e) {
    e.preventDefault();
    const name = $('#userNameInput').value.trim();
    state.user.name = name;
    save();
    renderUser();
    closeUserModal();
    if (name) toast(`👋 Welcome, ${name}!`);
  }

  function renderSidebar() {
    const list = $('#projectList');
    list.innerHTML = '';

    state.projects.forEach((proj, idx) => {
      const tasks = tasksFor(proj.id);
      const total = tasks.length;
      const done = tasks.filter((t) => t.isCompleted).length;
      const pct = total === 0 ? 0 : Math.round((done / total) * 100);
      const isActive = proj.id === state.activeProjectId && screen === 'project';
      const isFirst = idx === 0;
      const isLast = idx === state.projects.length - 1;

      const btn = document.createElement('button');
      btn.className = 'project-item' + (isActive ? ' is-active' : '');
      btn.dataset.id = proj.id;
      btn.innerHTML = `
        <span class="proj-main">
          <span class="project-dot"></span>
          <span class="proj-name truncate">${escapeHTML(proj.name)}</span>
          <span class="proj-count">${total}</span>
          <span class="proj-actions">
            <span class="proj-act" title="Move up" data-action="move-up" data-id="${proj.id}" ${isFirst ? 'data-disabled="1"' : ''}>
              <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
            </span>
            <span class="proj-act" title="Move down" data-action="move-down" data-id="${proj.id}" ${isLast ? 'data-disabled="1"' : ''}>
              <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </span>
            <span class="proj-act" title="Rename project" data-action="rename-project" data-id="${proj.id}">
              <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </span>
            <span class="proj-act proj-act-del" title="Delete project" data-action="del-project" data-id="${proj.id}">
              <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
            </span>
          </span>
        </span>
        <span class="proj-bar" title="${done}/${total} completed (${pct}%)">
          <span class="proj-bar-fill" style="width:${pct}%"></span>
        </span>`;
      list.appendChild(btn);
    });

    $('#projectCount').textContent = `${state.projects.length}`;

    // Update today badge in sidebar
    const badge = $('#todayBadge');
    const todayCount = state.todayTaskIds.length;
    badge.textContent = `${todayCount}/5`;
    badge.classList.toggle('hidden', todayCount === 0);
  }

  /* ---------- Dashboard ---------- */
  function renderDashboard() {
    const allTasks = state.tasks;
    const total = allTasks.length;
    const done = allTasks.filter((t) => t.isCompleted).length;
    const active = total - done;
    const overdue = allTasks.filter(isOverdue).length;

    $('#statTotal').textContent = total;
    $('#statCompleted').textContent = done;
    $('#statActive').textContent = active;
    $('#statOverdue').textContent = overdue;
    $('#statCompletedFoot').textContent = total > 0 ? `${Math.round((done / total) * 100)}% done` : '0% done';
    $('#statTotalFoot').textContent = `across ${state.projects.length} project${state.projects.length === 1 ? '' : 's'}`;

    // Gauge
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    $('#gaugeFill').style.strokeDashoffset = 100 - pct;
    $('#gaugeLabel').textContent = pct + '%';

    // Bar chart (tasks by project)
    const chartEl = $('#projBarChart');
    chartEl.innerHTML = '';
    if (state.projects.length === 0) {
      chartEl.innerHTML = '<p class="text-sm text-slate-400 text-center py-4">No projects yet</p>';
    } else {
      state.projects.forEach((proj) => {
        const tasks = tasksFor(proj.id);
        const t = tasks.length;
        const d = tasks.filter((x) => x.isCompleted).length;
        const p = t === 0 ? 0 : Math.round((d / t) * 100);
        const row = document.createElement('div');
        row.className = 'bc-row';
        row.innerHTML = `
          <div class="bc-label">
            <span class="truncate max-w-[150px]">${escapeHTML(proj.name)}</span>
            <span class="text-slate-400 ml-2 shrink-0">${d}/${t} · ${p}%${sumEstimate(tasks) > 0 ? ` · ⏱ ${formatEstimate(sumEstimate(tasks))}` : ''}</span>
          </div>
          <div class="bc-track">
            <div class="bc-fill" style="width:${p}%"></div>
          </div>`;
        chartEl.appendChild(row);
      });
    }

    // Priority breakdown
    const prioEl = $('#priorityBreakdown');
    prioEl.innerHTML = '';
    const prColors = { High: '#ef4444', Medium: '#f97316', Low: '#94a3b8' };
    ['High', 'Medium', 'Low'].forEach((pr) => {
      const cnt = allTasks.filter((t) => t.priority === pr).length;
      const p = total === 0 ? 0 : Math.round((cnt / total) * 100);
      prioEl.innerHTML += `
        <div class="pr-bar-row">
          <div class="bc-label">
            <span>${pr}</span>
            <span class="text-slate-400">${cnt} task${cnt === 1 ? '' : 's'}</span>
          </div>
          <div class="pr-bar-track">
            <div class="pr-bar-fill" style="width:${p}%;background:${prColors[pr]};"></div>
          </div>
        </div>`;
    });

    // Matrix breakdown (detailed — names the actual tasks in each quadrant)
    const matEl = $('#matrixBreakdown');
    matEl.innerHTML = '';
    const projName = (id) => (state.projects.find((p) => p.id === id) || {}).name || '';
    QUADRANTS.forEach((q) => {
      const inQ = allTasks.filter((t) => inQuadrant(t, q));
      const active = inQ.filter((t) => !t.isCompleted);
      const shown = active.slice(0, 4);
      const more = active.length - shown.length;
      const rows = shown.map((t) => `
        <li class="mq-item" data-pid="${t.projectId}" title="Open ${escapeHTML(projName(t.projectId))}">
          <span class="mq-bullet"></span>
          <span class="mq-task">${escapeHTML(t.title)}</span>
          <span class="mq-proj">${escapeHTML(projName(t.projectId))}</span>
          ${t.estimateMin ? `<span class="mq-time">${escapeHTML(formatEstimate(t.estimateMin))}</span>` : ''}
        </li>`).join('');

      const body = active.length === 0
        ? `<p class="mq-empty">${inQ.length > 0 ? 'All done here — nicely cleared. ✓' : 'Nothing here yet.'}</p>`
        : `<ul class="mq-list">${rows}${more > 0 ? `<li class="mq-more">+${more} more task${more === 1 ? '' : 's'}</li>` : ''}</ul>`;

      matEl.innerHTML += `
        <div class="mq-card ${q.cls}">
          <div class="mq-top">
            <span class="mq-dot"></span>
            <div class="min-w-0 flex-1">
              <p class="mq-lead">${q.lead}</p>
              <p class="mq-advice">${q.advice}</p>
            </div>
            <span class="mq-count">${active.length}</span>
          </div>
          ${body}
        </div>`;
    });

    // Projects overview
    const projEl = $('#dashProjects');
    projEl.innerHTML = '';
    if (state.projects.length === 0) {
      projEl.innerHTML = '<p class="text-sm text-slate-400 text-center py-4">No projects yet — create one using the form below.</p>';
    } else {
      state.projects.forEach((proj) => {
        const tasks = tasksFor(proj.id);
        const t = tasks.length;
        const d = tasks.filter((x) => x.isCompleted).length;
        const p = t === 0 ? 0 : Math.round((d / t) * 100);
        const row = document.createElement('button');
        row.className = 'w-full flex items-center gap-3 p-3 rounded-xl hover:bg-slate-50 transition group text-left';
        row.innerHTML = `
          <div class="w-9 h-9 rounded-xl bg-indigo-100 text-indigo-700 grid place-items-center shrink-0 font-bold text-sm">
            ${escapeHTML(proj.name.charAt(0).toUpperCase())}
          </div>
          <div class="flex-1 min-w-0">
            <p class="font-semibold text-slate-800 truncate text-sm">${escapeHTML(proj.name)}</p>
            <div class="flex items-center gap-2 mt-1">
              <div class="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div class="h-full rounded-full bg-indigo-500 transition-all duration-500" style="width:${p}%;"></div>
              </div>
              <span class="text-xs text-slate-400 shrink-0">${d}/${t}${sumEstimate(tasks) > 0 ? ` · ⏱ ${formatEstimate(sumEstimate(tasks))}` : ''}</span>
            </div>
          </div>
          <svg class="w-4 h-4 text-slate-300 group-hover:text-slate-400 shrink-0 transition" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>`;
        row.addEventListener('click', () => {
          state.activeProjectId = proj.id;
          switchScreen('project');
          render();
          closeSidebar();
        });
        projEl.appendChild(row);
      });
    }
  }

  /* ---------- Fullscreen focus mode ---------- */
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function toggleFullscreen() {
    const el = document.documentElement;
    if (!isFullscreen()) {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) req.call(el).catch(() => toast('Fullscreen not available'));
      else toast('Fullscreen not supported here');
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
  }

  function syncFullscreenBtn() {
    const btn = $('#todayFullscreenBtn');
    if (!btn) return;
    const on = isFullscreen();
    btn.querySelector('.fs-open').classList.toggle('hidden', on);
    btn.querySelector('.fs-close').classList.toggle('hidden', !on);
    const label = btn.querySelector('.fs-label');
    if (label) label.textContent = on ? 'Exit' : 'Fullscreen';
    // When entering fullscreen, jump to the Today's Focus screen.
    if (on && screen !== 'today') { switchScreen('today'); renderToday(); renderSidebar(); }
  }

  /* ---------- Rotating motivation quotes (Today's Focus) ---------- */
  const QUOTES = [
    { text: "And that there is not for man except that [good] for which he strives.", source: "Quran 53:39 🎯", note: "Your future isn't defined by what you wish for; it is defined by what you actively work for. 📈" },
    { text: "Indeed, Allah will not change the condition of a people until they change what is in themselves.", source: "Quran 13:11 🌱", note: "Growth starts with you. Don't wait for your circumstances to change before you start working. 🚀" },
    { text: "O Allah, I seek refuge in You from anxiety and sorrow, and I seek refuge in You from helplessness and laziness.", source: "Prophet Muhammad ﷺ 🛡️", note: "The Prophet actively made Dua against laziness — treat it like the enemy to your potential that it is. ❌" },
    { text: "Take benefit of five before five: your youth before your old age, your health before your sickness, your wealth before your poverty, your free time before your preoccupation, and your life before your death.", source: "Prophet Muhammad ﷺ ⏳", note: "" },
    { text: "A strong believer is better and more beloved to Allah than a weak believer, and there is good in everyone. Cherish that which benefits you, seek help from Allah, and do not feel helpless.", source: "Prophet Muhammad ﷺ 💪", note: "" },
    { text: "The iron is rust-eaten if it is not used; stagnant water loses its purity… even so does inaction sap the vigour of the mind.", source: "Islamic Wisdom ⚙️", note: "" },
    { text: "Laziness is nothing more than the habit of resting before you get tired. Get up and build something that outlives you.", source: "Unknown 🏗️", note: "" },
    { text: "Your alarm for Fajr is your first test of discipline for the day. If you can conquer your blanket, you can conquer your dreams.", source: "Unknown ☀️🌅", note: "" },
    { text: "Shaytan loves an idle mind and a lazy body. Keep yourself moving, keep yourself working, and keep yourself relevant.", source: "Unknown 🧠🏃", note: "" },
    { text: "Do not treat your youth as a vacation from responsibility. It is the foundation of your entire legacy.", source: "Unknown 💎", note: "" },
    { text: "So when you have finished [your duties], then stand up [for worship]. And to your Lord direct [your] longing.", source: "Quran 94:7-8 🔄", note: "Move directly from one productive task to another. True rest comes in Jannah. 🌌" },
    { text: "Indeed, Allah loves that when one of you does something, he does it with excellence (Ihsan).", source: "Prophet Muhammad ﷺ ✨", note: "Don't just aim to get by. Aim for top-tier quality, because Allah loves elite effort. 🏆" },
    { text: "Tomorrow is a hope, yesterday is a dream, today is a reality — act now.", source: "Umar ibn al-Khattāb 🗓️⚡", note: "" },
    { text: "Knowledge without action is insanity, and action without knowledge is vanity.", source: "Imam Al-Ghazali 📚🛠️", note: "" },
    { text: "Work for this world as if you will live forever, and work for the Hereafter as if you will die tomorrow.", source: "Ali ibn Abi Talib 🌍💫", note: "Build impactful projects in this life, but keep your heart tied to the Next. 👑" },
    { text: "Do not let your difficulties fill you with anxiety; after all, it is only in the darkest nights that stars shine more brightly.", source: "Ali ibn Abi Talib 🌃⭐", note: "" },
    { text: "You are part of an Ummah built by young people who shook the world. Stop scrolling and start building.", source: "Unknown 🛠️", note: "" },
    { text: "When you build a halal business, study your major, or code an app with the intention to serve people and please Allah, your work becomes worship.", source: "Unknown 💻💼", note: "" },
    { text: "Excuses don't build empires, nor do they earn Jannah. Show up even when you don't feel like it.", source: "Unknown 🥊", note: "" },
    { text: "Look at the companions of the Prophet — they were young, bold, ambitious and incredibly hardworking. Match their energy.", source: "Unknown ⚡🔥", note: "" },
    { text: "Actions are judged by intentions.", source: "Prophet Muhammad ﷺ 🫀", note: "A pure intention (Niyyah) turns your long study hours into heavy good deeds. ⚖️" },
    { text: "The best among you are those who have the best manners and character.", source: "Prophet Muhammad ﷺ 🤝", note: "" },
    { text: "A pure intention rewrites the value of your daily grind. You aren't just working for a grade — you're working to elevate the Ummah.", source: "Unknown 🌍", note: "" },
    { text: "Success isn't about being better than anyone else. It's about being better than you were yesterday, for the sake of Allah.", source: "Unknown 🔄📈", note: "" },
    { text: "Do your absolute best, tie your camel with precision, and let Allah handle the results. True peace is knowing you gave it 100%.", source: "Unknown 🐫🔒", note: "" },
    { text: "Consistency is the bridge between goals and accomplishment. A little work done every single day is beloved to Allah.", source: "Unknown 📅🧱", note: "" },
    { text: "Don't study just to get rich. Study to be wise, capable, and a source of strength for everyone around you.", source: "Unknown 🎓", note: "" },
    { text: "Your potential is a gift from Allah. What you do with that potential is your gift back to Him.", source: "Unknown 🎁✨", note: "" },
    { text: "Stop waiting for the 'perfect moment' or for 'motivation' to hit. Discipline over mood, always.", source: "Unknown ⏳", note: "" },
    { text: "The ultimate success is walking into Jannah knowing you didn't waste the life, the intellect, or the youth Allah trusted you with.", source: "Unknown 👑🏡", note: "" },
  ];
  let quoteIdx = 0;

  function renderQuote() {
    const el = $('#quoteText');
    if (!el) return;
    const q = QUOTES[quoteIdx % QUOTES.length];
    el.textContent = `“${q.text}”`;
    $('#quoteSource').textContent = `— ${q.source}`;
    const noteEl = $('#quoteNote');
    if (q.note) { noteEl.textContent = q.note; noteEl.classList.remove('hidden'); }
    else { noteEl.classList.add('hidden'); }
  }

  function rotateQuote() {
    quoteIdx = (quoteIdx + 1) % QUOTES.length;
    renderQuote();
  }

  /* ---------- Live clock + time remaining today ---------- */
  function updateClock() {
    const t = $('#clockTime');
    if (!t) return;
    const now = new Date();
    t.textContent = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('#clockDate').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    // Remaining until midnight + how much of the day has elapsed.
    const end = new Date(now); end.setHours(24, 0, 0, 0);
    const msLeft = end - now;
    const minsLeft = Math.floor(msLeft / 60000);
    const h = Math.floor(minsLeft / 60), m = minsLeft % 60;
    $('#timeRemaining').textContent = `${h}h ${String(m).padStart(2, '0')}m left`;
    const elapsedPct = Math.min(100, Math.max(0, (1 - msLeft / 86400000) * 100));
    $('#dayProgressBar').style.width = elapsedPct.toFixed(1) + '%';
  }

  /* ---------- Today's Focus ---------- */
  function renderToday() {
    const todayTasks = state.todayTaskIds
      .map((id) => state.tasks.find((t) => t.id === id))
      .filter(Boolean);
    const total = todayTasks.length;
    const done = todayTasks.filter((t) => t.isCompleted).length;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);

    // Count badge (sidebar + panel)
    $('#todayCount').textContent = `${total} / 5`;
    const badge = $('#todayBadge');
    badge.textContent = `${total}/5`;
    badge.classList.toggle('hidden', total === 0);

    // Progress ring + bar
    $('#todayProgressBar').style.width = pct + '%';
    $('#todayProgressPct').textContent = pct + '%';
    $('#todayProgressRing').style.setProperty('--pct', pct);
    $('#todayDoneCount').textContent = `${done} of ${total} done today`;

    let sub;
    if (total === 0) sub = 'Pick tasks to focus on';
    else if (pct === 100) sub = '🎉 All done — amazing work today!';
    else if (pct >= 50) sub = 'Over halfway there — keep going!';
    else sub = `${total} task${total === 1 ? '' : 's'} locked in for today.`;
    $('#todaySubLabel').textContent = sub;

    // Pick button state
    const addBtn = $('#addTodayTask');
    addBtn.disabled = total >= 5;

    // Task list
    const listEl = $('#todayList');
    const emptyEl = $('#todayEmpty');

    if (total === 0) {
      emptyEl.classList.remove('hidden');
      listEl.innerHTML = '';
    } else {
      emptyEl.classList.add('hidden');
      listEl.innerHTML = '';
      todayTasks.forEach((task) => {
        const proj = state.projects.find((p) => p.id === task.projectId);
        const row = document.createElement('div');
        row.className = `task-row pr-${task.priority}${task.isCompleted ? ' is-done' : ''}`;
        row.dataset.id = task.id;
        row.innerHTML = `
          <input type="checkbox" class="task-check" data-action="today-toggle" ${task.isCompleted ? 'checked' : ''} aria-label="Complete task" />
          <div class="min-w-0 flex-1">
            <p class="task-title">${escapeHTML(task.title)}</p>
            <div class="flex items-center gap-2 mt-1 flex-wrap">
              <span class="badge badge-${task.priority}">${task.priority}</span>
              ${estBadge(task)}
              <span class="text-xs text-slate-400">${escapeHTML(proj ? proj.name : '')}</span>
            </div>
          </div>
          <button class="task-edit" data-action="edit" title="Edit task" aria-label="Edit task">
            <svg class="w-4 h-4 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button class="task-del" data-action="today-remove" title="Remove from today" aria-label="Remove from today">
            <svg class="w-4 h-4 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>`;
        listEl.appendChild(row);
      });
    }

    // Slot pips (5 dots showing how many slots used)
    const slotsEl = $('#todaySlots');
    slotsEl.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const pip = document.createElement('div');
      pip.className = `h-1.5 rounded-full transition-all duration-300 ${i < total ? 'bg-indigo-500' : 'bg-slate-100'}`;
      slotsEl.appendChild(pip);
    }
  }

  /* ---------- Task Picker ---------- */
  function openTaskPicker() {
    $('#taskPickerModal').classList.remove('hidden');
    const input = $('#taskPickerSearch');
    input.value = '';
    renderTaskPickerList('');
    requestAnimationFrame(() => input.focus());
  }

  function closeTaskPicker() {
    $('#taskPickerModal').classList.add('hidden');
  }

  function renderTaskPickerList(query) {
    const slotsLeft = 5 - state.todayTaskIds.length;
    $('#pickerSlotsLeft').textContent = slotsLeft === 0
      ? 'No slots remaining — today is full!'
      : `${slotsLeft} slot${slotsLeft === 1 ? '' : 's'} remaining`;

    const listEl = $('#taskPickerList');
    listEl.innerHTML = '';

    // All incomplete tasks not already in today
    let candidates = state.tasks.filter(
      (t) => !t.isCompleted && !state.todayTaskIds.includes(t.id)
    );

    if (query.trim()) {
      const q = query.toLowerCase();
      candidates = candidates.filter((t) => t.title.toLowerCase().includes(q));
    }

    if (candidates.length === 0) {
      listEl.innerHTML = `<p class="text-center text-sm text-slate-400 py-8">${
        query.trim() ? 'No matching tasks found.' : 'All tasks are already added or completed.'
      }</p>`;
      return;
    }

    // Group by project
    const byProject = new Map();
    candidates.forEach((t) => {
      if (!byProject.has(t.projectId)) byProject.set(t.projectId, []);
      byProject.get(t.projectId).push(t);
    });

    byProject.forEach((tasks, projId) => {
      const proj = state.projects.find((p) => p.id === projId);
      if (!proj) return;

      const section = document.createElement('div');
      section.innerHTML = `<p class="text-xs font-semibold text-slate-400 uppercase tracking-wider px-2 py-2">${escapeHTML(proj.name)}</p>`;

      tasks.forEach((task) => {
        const btn = document.createElement('button');
        btn.className = 'w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-indigo-50 transition group';
        btn.disabled = slotsLeft === 0;
        const prDot = task.priority === 'High' ? 'bg-red-400' : task.priority === 'Medium' ? 'bg-orange-400' : 'bg-slate-300';
        btn.innerHTML = `
          <span class="w-2 h-2 rounded-full shrink-0 ${prDot}"></span>
          <span class="flex-1 text-sm font-medium text-slate-700 truncate">${escapeHTML(task.title)}</span>
          ${task.estimateMin ? `<span class="text-xs font-medium text-slate-400 shrink-0">${escapeHTML(formatEstimate(task.estimateMin))}</span>` : ''}
          <span class="text-xs font-semibold text-indigo-600 opacity-0 group-hover:opacity-100 shrink-0 transition">Add →</span>`;
        btn.addEventListener('click', () => {
          if (state.todayTaskIds.length >= 5) { toast('Today is full — max 5 tasks'); return; }
          state.todayTaskIds.push(task.id);
          save();
          renderToday();
          if (state.todayTaskIds.length >= 5) {
            closeTaskPicker();
            toast('Today locked in — let\'s go!');
          } else {
            renderTaskPickerList($('#taskPickerSearch').value);
          }
        });
        section.appendChild(btn);
      });

      listEl.appendChild(section);
    });
  }

  /* ---------- Project screen ---------- */
  function renderHeader() {
    const proj = activeProject();
    $('#activeProjectName').textContent = proj ? proj.name : '—';

    const tasks = proj ? tasksFor(proj.id) : [];
    const done = tasks.filter((t) => t.isCompleted).length;
    const overdue = tasks.filter(isOverdue).length;

    let meta;
    if (tasks.length === 0) meta = 'No tasks yet';
    else {
      meta = `${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${done} done`;
      if (overdue > 0) meta += ` · ${overdue} overdue`;
      const totalMin = sumEstimate(tasks);
      if (totalMin > 0) meta += ` · ⏱ ${formatEstimate(totalMin)} planned`;
    }
    $('#activeProjectMeta').textContent = meta;

    $('#deleteProjectBtn').disabled = state.projects.length <= 1;
    $('#deleteProjectBtn').classList.toggle('opacity-40', state.projects.length <= 1);
    $('#deleteProjectBtn').classList.toggle('pointer-events-none', state.projects.length <= 1);
  }

  function renderProgress() {
    const proj = activeProject();
    const tasks = proj ? tasksFor(proj.id) : [];
    const total = tasks.length;
    const done = tasks.filter((t) => t.isCompleted).length;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);

    $('#progressBar').style.width = pct + '%';
    $('#progressPercentLabel').textContent = pct + '%';
    $('#progressRing').style.setProperty('--pct', pct);
    $('#progressCountLabel').textContent = `${done} of ${total} task${total === 1 ? '' : 's'} completed`;

    let sub;
    if (total === 0) sub = 'Add a task to get started';
    else if (pct === 100) sub = '🎉 All done — great work!';
    else if (pct >= 50) sub = 'Over halfway there!';
    else sub = "Let's build some momentum.";
    $('#progressSubLabel').textContent = sub;

    // Time planned vs. remaining for this project.
    const totalMin = sumEstimate(tasks);
    const remainingMin = sumEstimate(tasks.filter((t) => !t.isCompleted));
    const timeLabel = $('#progressTimeLabel');
    if (totalMin > 0) {
      timeLabel.classList.remove('hidden');
      $('#progressTimeText').textContent = remainingMin > 0
        ? `${formatEstimate(remainingMin)} of work left · ${formatEstimate(totalMin)} planned total`
        : `All ${formatEstimate(totalMin)} of planned work done`;
    } else {
      timeLabel.classList.add('hidden');
    }
  }

  // Show either the List or the Matrix; only one is in the DOM flow at a time.
  function renderView() {
    const isMatrix = view === 'matrix';
    $('#taskList').classList.toggle('hidden', isMatrix);
    $('#emptyState').classList.toggle('hidden', isMatrix);
    $('#matrixView').classList.toggle('hidden', !isMatrix);
    $('#filterChips').classList.toggle('invisible', isMatrix);
    if (isMatrix) renderMatrix();
    else renderTasks();
  }

  function renderTasks() {
    const listEl = $('#taskList');
    const proj = activeProject();
    let tasks = proj ? tasksFor(proj.id) : [];

    if (filter === 'active') tasks = tasks.filter((t) => !t.isCompleted);
    else if (filter === 'done') tasks = tasks.filter((t) => t.isCompleted);

    const prRank = { High: 0, Medium: 1, Low: 2 };
    tasks = [...tasks].sort((a, b) => {
      if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
      if (prRank[a.priority] !== prRank[b.priority]) return prRank[a.priority] - prRank[b.priority];
      const da = a.deadline || '9999-12-31';
      const db = b.deadline || '9999-12-31';
      return da.localeCompare(db);
    });

    listEl.innerHTML = '';
    const emptyEl = $('#emptyState');
    const totalForProject = proj ? tasksFor(proj.id).length : 0;

    if (tasks.length === 0) {
      emptyEl.classList.remove('hidden');
      $('#emptyStateText').textContent =
        totalForProject === 0 ? 'No tasks yet'
        : filter === 'active' ? 'No active tasks — all done!'
        : 'No completed tasks yet';
      return;
    }
    emptyEl.classList.add('hidden');
    tasks.forEach((task) => listEl.appendChild(taskRow(task)));
  }

  function taskRow(task, opts = {}) {
    const row = document.createElement('div');
    row.className = `task-row pr-${task.priority}` + (task.isCompleted ? ' is-done' : '') + (opts.draggable ? ' is-draggable' : '');
    row.dataset.id = task.id;

    const overdue = isOverdue(task);
    const dueHTML = task.deadline
      ? `<span class="due ${overdue ? 'overdue' : ''}">
           <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
           ${overdue ? 'Overdue · ' : ''}${escapeHTML(formatDate(task.deadline))}
         </span>`
      : '';

    row.innerHTML = `
      <input type="checkbox" class="task-check" data-action="toggle" ${task.isCompleted ? 'checked' : ''} aria-label="Complete task" />
      <div class="min-w-0 flex-1">
        <p class="task-title">${escapeHTML(task.title)}</p>
        <div class="flex items-center gap-2.5 mt-1.5 flex-wrap">
          <span class="badge badge-${task.priority}">${task.priority}</span>
          ${estBadge(task)}
          ${dueHTML}
        </div>
      </div>
      <button class="task-tag ${task.important ? 'on-imp' : ''}" data-action="toggle-important" title="${task.important ? 'Important' : 'Mark important'}" aria-pressed="${task.important}">★</button>
      <button class="task-tag ${task.urgent ? 'on-urg' : ''}" data-action="toggle-urgent" title="${task.urgent ? 'Urgent' : 'Mark urgent'}" aria-pressed="${task.urgent}">⚡</button>
      <button class="task-edit" data-action="edit" title="Edit task" aria-label="Edit task">
        <svg class="w-4 h-4 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      </button>
      <button class="task-del" data-action="delete" title="Delete task" aria-label="Delete task">
        <svg class="w-4 h-4 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6"/></svg>
      </button>`;
    return row;
  }

  /* ---------- Eisenhower Matrix ---------- */
  const QUADRANTS = [
    { key: 'do',       cls: 'do',       icon: '🟢', title: 'Do',       sub: 'Important · Urgent',         lead: "Important & urgent for you",        advice: 'Do these first',              imp: true,  urg: true  },
    { key: 'schedule', cls: 'schedule', icon: '🟠', title: 'Schedule', sub: 'Important · Not urgent',     lead: "Important, but not urgent",         advice: 'Schedule time for these',     imp: true,  urg: false },
    { key: 'delegate', cls: 'delegate', icon: '🔵', title: 'Delegate', sub: 'Not important · Urgent',     lead: "Urgent, but not important",         advice: 'Delegate or knock out fast',  imp: false, urg: true  },
    { key: 'del',      cls: 'del',      icon: '🔴', title: 'Delete',   sub: 'Not important · Not urgent', lead: "Neither important nor urgent",      advice: 'Drop or defer these',         imp: false, urg: false },
  ];
  const inQuadrant = (t, q) => t.important === q.imp && t.urgent === q.urg;

  function renderMatrix() {
    const wrap = $('#matrixView');
    const proj = activeProject();
    const tasks = proj ? tasksFor(proj.id) : [];
    wrap.innerHTML = '';

    QUADRANTS.forEach((q) => {
      const items = tasks.filter((t) => inQuadrant(t, q));
      const quad = document.createElement('div');
      quad.className = `quad ${q.cls}`;
      quad.dataset.quad = q.key;
      quad.innerHTML = `
        <div class="quad-head">
          <div class="qt">${q.icon} ${q.title}<span class="qcount">${items.length}</span></div>
          <div class="qs">${q.sub}</div>
        </div>
        <div class="quad-body"></div>`;
      const body = quad.querySelector('.quad-body');
      if (items.length === 0) {
        body.innerHTML = `<p class="quad-empty">Drop tasks here</p>`;
      } else {
        items
          .slice()
          .sort((a, b) => (a.isCompleted === b.isCompleted ? 0 : a.isCompleted ? 1 : -1))
          .forEach((t) => body.appendChild(taskRow(t, { draggable: true })));
      }
      wrap.appendChild(quad);
    });
  }

  /* ============================================================
     ACTIONS
     ============================================================ */

  function addProject(name) {
    name = name.trim();
    if (!name) return;
    const proj = { id: uid(), name };
    state.projects.push(proj);
    state.activeProjectId = proj.id;
    save();
    switchScreen('project');
    render();
    toast(`Project "${name}" created`);
  }

  function deleteProject(id) {
    if (state.projects.length <= 1) return;
    const proj = state.projects.find((p) => p.id === id);
    if (!proj) return;
    const taskCount = tasksFor(id).length;
    const msg = taskCount > 0
      ? `Delete "${proj.name}" and its ${taskCount} task${taskCount === 1 ? '' : 's'}?`
      : `Delete project "${proj.name}"?`;
    if (!confirm(msg)) return;

    // Remove today task ids that belonged to this project
    const taskIds = new Set(tasksFor(id).map((t) => t.id));
    state.todayTaskIds = state.todayTaskIds.filter((tid) => !taskIds.has(tid));

    state.projects = state.projects.filter((p) => p.id !== id);
    state.tasks = state.tasks.filter((t) => t.projectId !== id);
    if (state.activeProjectId === id) state.activeProjectId = state.projects[0].id;
    save();
    render();
    toast('Project deleted');
  }

  function moveProject(id, dir) {
    const i = state.projects.findIndex((p) => p.id === id);
    if (i < 0) return;
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= state.projects.length) return;
    [state.projects[i], state.projects[j]] = [state.projects[j], state.projects[i]];
    save();
    renderSidebar();
    if (screen === 'dashboard') renderDashboard();
  }

  /* ---------- Rename a project ---------- */
  let renamingProjectId = null;

  function openRenameProject(id) {
    const proj = state.projects.find((p) => p.id === id);
    if (!proj) return;
    renamingProjectId = id;
    const input = $('#renameProjectInput');
    input.value = proj.name;
    $('#renameProjectModal').classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  function closeRenameProject() {
    $('#renameProjectModal').classList.add('hidden');
    renamingProjectId = null;
  }

  function saveRenameProject(e) {
    e.preventDefault();
    const proj = state.projects.find((p) => p.id === renamingProjectId);
    if (!proj) { closeRenameProject(); return; }
    const name = $('#renameProjectInput').value.trim();
    if (!name) return;
    proj.name = name;
    save();
    render();
    closeRenameProject();
    toast('Project renamed');
  }

  function selectProject(id) {
    state.activeProjectId = id;
    filter = 'all';
    syncFilterChips();
    save();
    switchScreen('project');
    render();
    closeSidebar();
  }

  function addTask({ title, priority, deadline, urgent, important, estimateMin }) {
    title = title.trim();
    if (!title || !state.activeProjectId) return;
    const task = {
      id: uid(),
      projectId: state.activeProjectId,
      title,
      priority: ['High', 'Medium', 'Low'].includes(priority) ? priority : 'Medium',
      deadline: deadline || null,
      isCompleted: false,
      urgent: !!urgent,
      important: !!important,
      estimateMin: estimateMin || null,
    };
    state.tasks.push(task);
    save();
    render();
  }

  function toggleTask(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    task.isCompleted = !task.isCompleted;
    save();
    render();
  }

  function toggleTaskFlag(id, flag) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task || (flag !== 'urgent' && flag !== 'important')) return;
    task[flag] = !task[flag];
    save();
    render();
  }

  /* ---------- Edit an existing task ---------- */
  let editingTaskId = null;

  function openEditTask(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    editingTaskId = id;
    $('#editTaskTitle').value = task.title;
    $('#editTaskPriority').value = ['High', 'Medium', 'Low'].includes(task.priority) ? task.priority : 'Medium';
    $('#editTaskDeadline').value = task.deadline || '';
    $('#editTaskEstimate').value = task.estimateMin ? formatEstimate(task.estimateMin) : '';
    $('#editImportant').dataset.on = task.important ? 'true' : 'false';
    $('#editUrgent').dataset.on = task.urgent ? 'true' : 'false';
    $('#editTaskModal').classList.remove('hidden');
    setTimeout(() => $('#editTaskTitle').focus(), 50);
  }

  function closeEditTask() {
    $('#editTaskModal').classList.add('hidden');
    editingTaskId = null;
  }

  function saveEditTask(e) {
    e.preventDefault();
    const task = state.tasks.find((t) => t.id === editingTaskId);
    if (!task) { closeEditTask(); return; }
    const title = $('#editTaskTitle').value.trim();
    if (!title) return;
    task.title = title;
    task.priority = ['High', 'Medium', 'Low'].includes($('#editTaskPriority').value) ? $('#editTaskPriority').value : 'Medium';
    task.deadline = $('#editTaskDeadline').value || null;
    task.estimateMin = parseEstimate($('#editTaskEstimate').value);
    task.important = $('#editImportant').dataset.on === 'true';
    task.urgent = $('#editUrgent').dataset.on === 'true';
    save();
    render();
    closeEditTask();
    toast('Task updated');
  }

  function moveTaskToQuadrant(id, quadKey) {
    const task = state.tasks.find((t) => t.id === id);
    const q = QUADRANTS.find((x) => x.key === quadKey);
    if (!task || !q) return;
    if (task.important === q.imp && task.urgent === q.urg) return;
    task.important = q.imp;
    task.urgent = q.urg;
    save();
    render();
    toast(`Moved to "${q.title}"`);
  }

  function removeFromToday(id) {
    state.todayTaskIds = state.todayTaskIds.filter((tid) => tid !== id);
    save();
    renderToday();
    renderSidebar();
  }

  /* ---------- Pointer-based drag & drop ---------- */
  function setupMatrixDnD() {
    const grid = $('#matrixView');
    let drag = null;
    let holdTimer = null;

    const quadAtPoint = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el ? el.closest('.quad') : null;
    };
    const clearHints = () => $$('.quad.drag-over', grid).forEach((q) => q.classList.remove('drag-over'));
    const highlight = (x, y) => {
      const quad = quadAtPoint(x, y);
      $$('.quad.drag-over', grid).forEach((q) => { if (q !== quad) q.classList.remove('drag-over'); });
      if (quad && !quad.classList.contains('drag-over')) quad.classList.add('drag-over');
    };

    function arm() {
      if (!drag || drag.active) return;
      drag.active = true;
      const r = drag.row.getBoundingClientRect();
      const ghost = drag.row.cloneNode(true);
      ghost.classList.add('drag-ghost');
      ghost.style.width = r.width + 'px';
      drag.offX = drag.startX - r.left;
      drag.offY = drag.startY - r.top;
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      drag.row.classList.add('dragging');
      document.body.classList.add('dnd-active');
      positionGhost(drag.startX, drag.startY);
      highlight(drag.startX, drag.startY);
    }
    function positionGhost(x, y) {
      if (!drag || !drag.ghost) return;
      drag.ghost.style.left = (x - drag.offX) + 'px';
      drag.ghost.style.top = (y - drag.offY) + 'px';
    }

    function teardown(commit, x, y) {
      clearTimeout(holdTimer); holdTimer = null;
      if (drag) {
        if (drag.active && commit) {
          const quad = quadAtPoint(x, y);
          if (quad) moveTaskToQuadrant(drag.id, quad.dataset.quad);
        }
        if (drag.ghost) drag.ghost.remove();
        drag.row.classList.remove('dragging');
      }
      clearHints();
      document.body.classList.remove('dnd-active');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      drag = null;
    }

    const onMove = (e) => {
      if (!drag) return;
      if (drag.active) {
        e.preventDefault();
        positionGhost(e.clientX, e.clientY);
        highlight(e.clientX, e.clientY);
        return;
      }
      const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (drag.pointerType === 'mouse') {
        if (moved > 6) arm();
      } else if (moved > 14) {
        teardown(false);
      }
    };
    const onUp = (e) => teardown(true, e.clientX, e.clientY);
    const onCancel = () => teardown(false);

    grid.addEventListener('pointerdown', (e) => {
      if (e.button && e.button !== 0) return;
      const row = e.target.closest('.task-row');
      if (!row) return;
      if (e.target.closest('[data-action]')) return;
      drag = { id: row.dataset.id, row, ghost: null, startX: e.clientX, startY: e.clientY, active: false, pointerType: e.pointerType };
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      if (e.pointerType !== 'mouse') holdTimer = setTimeout(arm, 180);
    });
  }

  function deleteTask(id) {
    state.todayTaskIds = state.todayTaskIds.filter((tid) => tid !== id);
    state.tasks = state.tasks.filter((t) => t.id !== id);
    save();
    render();
  }

  /* ============================================================
     EVENT WIRING
     ============================================================ */

  function bindEvents() {
    // --- Nav ---
    $('#dashboardNav').addEventListener('click', () => { switchScreen('dashboard'); render(); });
    $('#todayNav').addEventListener('click', () => { switchScreen('today'); renderToday(); renderSidebar(); });
    $('#guideNav').addEventListener('click', () => { switchScreen('guide'); renderSidebar(); });
    $('#guideStartBtn').addEventListener('click', () => { switchScreen('dashboard'); render(); });

    // --- Guide quick-tour cards ---
    $$('.guide-card').forEach((card) => {
      card.addEventListener('click', () => {
        const goto = card.dataset.goto;
        if (goto === 'dashboard')    { switchScreen('dashboard'); render(); }
        else if (goto === 'today')   { switchScreen('today'); renderToday(); renderSidebar(); }
        else if (goto === 'project') { if (state.activeProjectId) selectProject(state.activeProjectId); }
        else if (goto === 'account') { openUserModal(); }
      });
    });

    // --- Dashboard quick buttons ---
    $('#dashNewProject').addEventListener('click', () => {
      $('#newProjectInput').focus();
      closeSidebar();
    });
    $('#dashOpenTasks').addEventListener('click', () => {
      if (state.projects.length > 0) selectProject(state.activeProjectId || state.projects[0].id);
    });

    // --- Add project ---
    $('#addProjectForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#newProjectInput');
      addProject(input.value);
      input.value = '';
    });

    // --- Project list (sidebar) ---
    $('#projectList').addEventListener('click', (e) => {
      const act = e.target.closest('[data-action]');
      if (act) {
        e.stopPropagation();
        if (act.dataset.disabled === '1') return;
        const id = act.dataset.id;
        switch (act.dataset.action) {
          case 'del-project':    deleteProject(id); break;
          case 'rename-project': openRenameProject(id); break;
          case 'move-up':        moveProject(id, 'up'); break;
          case 'move-down':      moveProject(id, 'down'); break;
        }
        return;
      }
      const item = e.target.closest('.project-item');
      if (item) selectProject(item.dataset.id);
    });

    // --- Delete active project ---
    $('#deleteProjectBtn').addEventListener('click', () => {
      if (state.activeProjectId) deleteProject(state.activeProjectId);
    });

    // --- Dashboard: open a project from overview ---
    $('#dashProjects').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-project-id]');
      if (btn) selectProject(btn.dataset.projectId);
    });

    // --- Dashboard: open a project from a Focus Matrix task ---
    $('#matrixBreakdown').addEventListener('click', (e) => {
      const item = e.target.closest('.mq-item[data-pid]');
      if (item) selectProject(item.dataset.pid);
    });

    // --- Eisenhower toggles ---
    [['#newImportant'], ['#newUrgent'], ['#editImportant'], ['#editUrgent']].forEach(([sel]) => {
      $(sel).addEventListener('click', () => {
        const btn = $(sel);
        btn.dataset.on = btn.dataset.on === 'true' ? 'false' : 'true';
      });
    });

    // --- Add task ---
    $('#addTaskForm').addEventListener('submit', (e) => {
      e.preventDefault();
      addTask({
        title: $('#taskTitle').value,
        priority: $('#taskPriority').value,
        deadline: $('#taskDeadline').value,
        important: $('#newImportant').dataset.on === 'true',
        urgent: $('#newUrgent').dataset.on === 'true',
        estimateMin: parseEstimate($('#taskEstimate').value),
      });
      $('#taskTitle').value = '';
      $('#taskDeadline').value = defaultDeadline();
      $('#taskEstimate').value = '';
      $('#newImportant').dataset.on = 'false';
      $('#newUrgent').dataset.on = 'false';
      $('#taskTitle').focus();
    });

    // --- Task interactions (project screen) ---
    const handleTaskClick = (e) => {
      const action = e.target.closest('[data-action]');
      if (!action) return;
      const row = e.target.closest('.task-row');
      if (!row) return;
      const id = row.dataset.id;
      switch (action.dataset.action) {
        case 'toggle':           toggleTask(id); break;
        case 'delete':           deleteTask(id); break;
        case 'edit':             openEditTask(id); break;
        case 'toggle-important': toggleTaskFlag(id, 'important'); break;
        case 'toggle-urgent':    toggleTaskFlag(id, 'urgent'); break;
      }
    };
    $('#taskList').addEventListener('click', handleTaskClick);
    $('#matrixView').addEventListener('click', handleTaskClick);

    // --- Today screen task interactions ---
    $('#todayList').addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]');
      if (!action) return;
      const row = e.target.closest('.task-row');
      if (!row) return;
      const id = row.dataset.id;
      if (action.dataset.action === 'today-toggle') { toggleTask(id); renderToday(); renderSidebar(); }
      if (action.dataset.action === 'today-remove') { removeFromToday(id); }
      if (action.dataset.action === 'edit') { openEditTask(id); }
    });

    // --- Today: fullscreen focus mode ---
    $('#todayFullscreenBtn').addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', syncFullscreenBtn);
    document.addEventListener('webkitfullscreenchange', syncFullscreenBtn);

    // --- Today: pick tasks ---
    $('#addTodayTask').addEventListener('click', openTaskPicker);
    $('#addTodayTaskEmpty').addEventListener('click', openTaskPicker);

    // --- Task picker ---
    $('#taskPickerClose').addEventListener('click', closeTaskPicker);
    $('#taskPickerOverlay').addEventListener('click', closeTaskPicker);
    $('#taskPickerSearch').addEventListener('input', (e) => renderTaskPickerList(e.target.value));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeTaskPicker(); closeEditTask(); closeRenameProject(); }
    });

    // --- Drag & drop ---
    setupMatrixDnD();

    // --- View switch (List / Matrix) ---
    $$('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (view === btn.dataset.view) return;
        view = btn.dataset.view;
        $$('.seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
        renderView();
      });
    });

    // --- Filters ---
    $$('.filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        filter = chip.dataset.filter;
        syncFilterChips();
        renderTasks();
      });
    });

    // --- Search (active only on the project screen) ---
    $('#searchInput').addEventListener('input', (e) => {
      if (screen !== 'project') return;
      const q = e.target.value.trim().toLowerCase();
      // Dim tasks that don't match (empty query restores all).
      $$('.task-row').forEach((row) => {
        const title = row.querySelector('.task-title');
        if (!title) return;
        const matches = !q || title.textContent.toLowerCase().includes(q);
        row.style.opacity = matches ? '1' : '0.3';
      });
    });
    $('#searchInput').addEventListener('search', () => {
      $$('.task-row').forEach((row) => row.style.opacity = '');
    });

    // --- Mobile sidebar ---
    $('#menuToggle').addEventListener('click', openSidebar);
    $('#backdrop').addEventListener('click', closeSidebar);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });

    // --- Cross-tab sync ---
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) { load(); render(); }
    });

    // --- User profile ---
    $('#userBtn').addEventListener('click', openUserModal);
    $('#userModalClose').addEventListener('click', closeUserModal);
    $('#userModalOverlay').addEventListener('click', closeUserModal);
    $('#userForm').addEventListener('submit', saveUser);

    // --- Cloud sign in / out ---
    $('#cloudSignInBtn').addEventListener('click', cloudSignIn);
    $('#cloudSignOutBtn').addEventListener('click', cloudSignOut);

    // --- Edit task modal ---
    $('#editTaskForm').addEventListener('submit', saveEditTask);
    $('#editTaskClose').addEventListener('click', closeEditTask);
    $('#editTaskOverlay').addEventListener('click', closeEditTask);

    // --- Rename project ---
    $('#renameProjectBtn').addEventListener('click', () => {
      if (state.activeProjectId) openRenameProject(state.activeProjectId);
    });
    $('#renameProjectForm').addEventListener('submit', saveRenameProject);
    $('#renameProjectClose').addEventListener('click', closeRenameProject);
    $('#renameProjectOverlay').addEventListener('click', closeRenameProject);

    // --- Dark mode toggle ---
    $('#themeToggle').addEventListener('click', () => {
      const isDark = document.documentElement.classList.toggle('dark');
      try { localStorage.setItem('liyaa.theme', isDark ? 'dark' : 'light'); } catch {}
      toast(isDark ? '🌙 Dark mode on' : '☀️ Light mode on');
    });
  }

  function syncFilterChips() {
    $$('.filter-chip').forEach((c) => c.classList.toggle('is-active', c.dataset.filter === filter));
  }

  /* ---------- Mobile sidebar ---------- */
  function openSidebar() {
    $('#sidebar').classList.remove('-translate-x-full');
    $('#backdrop').classList.remove('hidden');
  }
  function closeSidebar() {
    if (window.innerWidth >= 1024) return;
    $('#sidebar').classList.add('-translate-x-full');
    $('#backdrop').classList.add('hidden');
  }

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  /* ============================================================
     INIT
     ============================================================ */
  function init() {
    load();
    bindEvents();
    syncFilterChips();
    switchScreen('dashboard');
    render();

    // New tasks default to a deadline one week out.
    $('#taskDeadline').value = defaultDeadline();

    // Live clock on the Today's Focus screen.
    updateClock();
    setInterval(updateClock, 1000);

    // Rotating motivation quote — changes every 5 minutes.
    quoteIdx = Math.floor(Date.now() / 300000) % QUOTES.length;
    renderQuote();
    setInterval(rotateQuote, 300000);

    // Connect to the cloud (Google sign-in + sync) if it's configured.
    initCloud();

    // First run: ask for the user's name.
    if (!state.user.name) {
      setTimeout(openUserModal, 600);
    }

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('sw.js', { updateViaCache: 'none' })
          .then((reg) => {
            // Check for a newer version on every load.
            reg.update().catch(() => {});
          })
          .catch(() => {});

        // When a new service worker takes control, reload once so
        // HTML/CSS/JS are never mixed between versions.
        let reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (reloaded) return;
          reloaded = true;
          window.location.reload();
        });
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
