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
    customQuotes: [],    // user-added motivation quotes { text, source }
    hiddenQuotes: [],    // indices of built-in quotes the user removed
  };
  let filter = 'all';    // all | active | done
  let view   = 'list';   // list | matrix
  let sortBy = 'priority'; // priority | deadline | estimate | title | newest
  let labelFilter = '';  // when set, only show tasks with this label
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

  /* ---------- Labels ---------- */
  // Stable colour bucket (0–7) for a label string.
  function labelHue(label) {
    let h = 0;
    for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
    return h % 8;
  }
  // A clickable label chip (empty string if the task has no label).
  const labelChip = (task) => task.label
    ? `<button class="task-label lbl-${labelHue(task.label)}" data-action="filter-label" data-label="${escapeHTML(task.label)}" title="Filter by “${escapeHTML(task.label)}”">${escapeHTML(task.label)}</button>`
    : '';
  // All distinct labels currently in use (for autocomplete).
  const allLabels = () => [...new Set(state.tasks.map((t) => t.label).filter(Boolean))].sort();

  function refreshLabelOptions() {
    const dl = $('#labelOptions');
    if (!dl) return;
    dl.innerHTML = allLabels().map((l) => `<option value="${escapeHTML(l)}"></option>`).join('');
  }

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
        customQuotes: Array.isArray(parsed.customQuotes) ? parsed.customQuotes : [],
        hiddenQuotes: Array.isArray(parsed.hiddenQuotes) ? parsed.hiddenQuotes : [],
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
      if (typeof t.label !== 'string') t.label = '';
    });
    // Clean up stale todayTaskIds.
    const taskIds = new Set(state.tasks.map((t) => t.id));
    state.todayTaskIds = state.todayTaskIds.filter((id) => taskIds.has(id));

    if (!Array.isArray(state.customQuotes)) state.customQuotes = [];
    if (!Array.isArray(state.hiddenQuotes)) state.hiddenQuotes = [];
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
    $('#settingsScreen').classList.toggle('hidden', name !== 'settings');
    $('#dashboardNav').classList.toggle('is-active', name === 'dashboard');
    $('#todayNav').classList.toggle('is-active', name === 'today');
    $('#guideNav').classList.toggle('is-active', name === 'guide');
    $('#settingsNav').classList.toggle('is-active', name === 'settings');

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
    renderNotifs();
    if (screen === 'dashboard') renderDashboard();
    if (screen === 'today') renderToday();
    if (screen === 'settings') renderSettings();
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
      const shown = active.slice(0, 2);
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

  /* ============================================================
     NOTIFICATIONS
     In-app bell (overdue / due today / due tomorrow / focus
     reminders) + optional browser notifications while app is open.
     ============================================================ */
  function isoToday(offset = 0) {
    const d = todayStart();
    d.setDate(d.getDate() + offset);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Read-state log: which notification keys were marked read (resets daily).
  function notifReadLog() {
    let log;
    try { log = JSON.parse(localStorage.getItem('liyaa.notifRead') || 'null'); } catch { log = null; }
    if (!log || log.date !== isoToday()) log = { date: isoToday(), keys: [] };
    return log;
  }
  function saveNotifReadLog(log) {
    try { localStorage.setItem('liyaa.notifRead', JSON.stringify(log)); } catch {}
  }

  function buildNotifications() {
    const items = [];
    const open = state.tasks.filter((t) => !t.isCompleted);
    const pName = (id) => (state.projects.find((p) => p.id === id) || {}).name || '';

    open.filter(isOverdue).forEach((t) => items.push({
      key: 'over-' + t.id, icon: '🔴', tone: 'red', pid: t.projectId,
      title: t.title, sub: `Overdue — was due ${formatDate(t.deadline)} · ${pName(t.projectId)}`,
    }));
    open.filter((t) => t.deadline === isoToday()).forEach((t) => items.push({
      key: 'due-' + t.id, icon: '🟠', tone: 'orange', pid: t.projectId,
      title: t.title, sub: `Due today · ${pName(t.projectId)}`,
    }));
    open.filter((t) => t.deadline === isoToday(1)).forEach((t) => items.push({
      key: 'tom-' + t.id, icon: '🔵', tone: 'blue', pid: t.projectId,
      title: t.title, sub: `Due tomorrow · ${pName(t.projectId)}`,
    }));

    // Today's Focus status
    const todayTasks = state.todayTaskIds.map((id) => state.tasks.find((t) => t.id === id)).filter(Boolean);
    const left = todayTasks.filter((t) => !t.isCompleted).length;
    if (todayTasks.length > 0 && left > 0) {
      items.push({ key: 'focus-left', icon: '🎯', tone: 'indigo', goto: 'today',
        title: `${left} focus task${left === 1 ? '' : 's'} left today`, sub: "Open Today's Focus to finish strong" });
    } else if (todayTasks.length > 0 && left === 0) {
      items.push({ key: 'focus-done', icon: '🎉', tone: 'green', goto: 'today',
        title: 'Today\'s Focus complete!', sub: 'All your picked tasks are done — great work' });
    } else if (todayTasks.length === 0 && open.length > 0) {
      items.push({ key: 'focus-none', icon: '🎯', tone: 'indigo', goto: 'today',
        title: 'No focus tasks picked yet', sub: 'Pick up to 5 tasks to focus on today' });
    }
    return items;
  }

  function markAllNotifsRead() {
    const log = notifReadLog();
    buildNotifications().forEach((n) => { if (!log.keys.includes(n.key)) log.keys.push(n.key); });
    saveNotifReadLog(log);
    renderNotifs();
    toast('All notifications marked as read');
  }

  function renderNotifs() {
    const badge = $('#notifBadge');
    if (!badge) return;
    const items = buildNotifications();
    const readKeys = new Set(notifReadLog().keys);
    items.forEach((n) => { n.read = readKeys.has(n.key); });
    // Badge counts only unread, actionable alerts (not the celebration)
    const alerts = items.filter((n) => n.tone !== 'green' && !n.read).length;
    badge.textContent = alerts > 9 ? '9+' : alerts;
    badge.classList.toggle('hidden', alerts === 0);
    const unread = items.filter((n) => !n.read).length;
    $('#notifCount').textContent = items.length ? (unread ? `${unread} unread` : 'all read') : '';
    const markBtn = $('#notifMarkRead');
    if (markBtn) markBtn.classList.toggle('hidden', unread === 0);

    const list = $('#notifList');
    if (items.length === 0) {
      list.innerHTML = '<p class="text-center text-sm text-slate-400 py-8">All clear — nothing needs your attention 🎈</p>';
      return;
    }
    const tones = {
      red:    'bg-red-50 text-red-600',
      orange: 'bg-orange-50 text-orange-600',
      blue:   'bg-blue-50 text-blue-600',
      indigo: 'bg-indigo-50 text-indigo-600',
      green:  'bg-green-50 text-green-600',
    };
    list.innerHTML = '';
    items.forEach((n) => {
      const row = document.createElement('button');
      row.className = 'w-full flex items-start gap-3 p-2.5 rounded-xl hover:bg-slate-50 transition text-left notif-row' + (n.read ? ' opacity-50' : '');
      row.innerHTML = `
        <span class="w-9 h-9 grid place-items-center rounded-xl text-base shrink-0 ${tones[n.tone] || tones.indigo}">${n.icon}</span>
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-semibold text-slate-800 truncate">${escapeHTML(n.title)}</span>
          <span class="block text-xs text-slate-400 mt-0.5">${escapeHTML(n.sub)}</span>
        </span>
        ${n.read ? '' : '<span class="w-2 h-2 rounded-full bg-indigo-500 shrink-0 mt-1.5" title="Unread"></span>'}`;
      row.addEventListener('click', () => {
        // Opening a notification marks it read.
        const log = notifReadLog();
        if (!log.keys.includes(n.key)) { log.keys.push(n.key); saveNotifReadLog(log); }
        closeNotifPanel();
        if (n.goto === 'today') { switchScreen('today'); renderToday(); renderSidebar(); }
        else if (n.pid) selectProject(n.pid);
        renderNotifs();
      });
      list.appendChild(row);
    });
  }

  function toggleNotifPanel() {
    const panel = $('#notifPanel');
    const willOpen = panel.classList.contains('hidden');
    panel.classList.toggle('hidden');
    if (willOpen) renderNotifs();
  }
  function closeNotifPanel() { $('#notifPanel').classList.add('hidden'); }

  /* --- Browser notifications (fires while the app is open) --- */
  function pushReminderSupported() { return 'Notification' in window; }

  function syncPushBtn() {
    const btn = $('#notifEnablePush');
    if (!btn) return;
    if (!pushReminderSupported()) { btn.textContent = 'Browser reminders not supported here'; btn.disabled = true; return; }
    if (Notification.permission === 'granted') { btn.textContent = '✅ Browser reminders are on'; btn.disabled = true; }
    else if (Notification.permission === 'denied') { btn.textContent = 'Reminders blocked in browser settings'; btn.disabled = true; }
    else { btn.textContent = '🔔 Enable browser reminders'; btn.disabled = false; }
  }

  function enablePushReminders() {
    if (!pushReminderSupported()) return;
    Notification.requestPermission().then((perm) => {
      syncPushBtn();
      if (perm === 'granted') {
        toast('🔔 Reminders on — you\'ll be notified about deadlines');
        checkDeadlineReminders();
      }
    });
  }

  // Fire each reminder at most once per task per day.
  function checkDeadlineReminders() {
    if (!pushReminderSupported() || Notification.permission !== 'granted') return;
    let log;
    try { log = JSON.parse(localStorage.getItem('liyaa.notified') || 'null'); } catch { log = null; }
    if (!log || log.date !== isoToday()) log = { date: isoToday(), ids: [] };

    const open = state.tasks.filter((t) => !t.isCompleted);
    const fire = (key, title, body) => {
      if (log.ids.includes(key)) return;
      log.ids.push(key);
      try { new Notification(title, { body, icon: 'logo-mark.svg', badge: 'logo-mark.svg' }); } catch {}
    };

    open.filter(isOverdue).forEach((t) => fire('over-' + t.id, '🔴 Overdue: ' + t.title, `Was due ${formatDate(t.deadline)} — open Liyaatodo to finish it.`));
    open.filter((t) => t.deadline === isoToday()).forEach((t) => fire('due-' + t.id, '🟠 Due today: ' + t.title, 'This task\'s deadline is today.'));

    try { localStorage.setItem('liyaa.notified', JSON.stringify(log)); } catch {}
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

  /* ============================================================
     CHANGELOG  ("What's new")
     ============================================================ */
  const CHANGELOG = [
    { v: '2.6', type: 'feature',     title: 'Sort your task list',            desc: 'Sort a project’s tasks by priority, deadline, estimated time, name, or newest.' },
    { v: '2.5', type: 'feature',     title: 'Backup & restore',               desc: 'Export all your data to a file and import it back anytime — perfect for moving devices or keeping a safe copy.' },
    { v: '2.4', type: 'fix',         title: 'Erase options fixed',            desc: 'The “what to erase” choices now use an in-app confirm, so they work reliably everywhere — including the installed app.' },
    { v: '2.3', type: 'feature',     title: 'Settings & your own quotes',     desc: 'A new Settings screen: add and manage your own motivation quotes, reset the cache, and erase data by scope.' },
    { v: '2.2', type: 'feature',     title: 'Install as an app',              desc: 'Install Liyaatodo to your home screen or desktop for a full-screen, offline experience.' },
    { v: '2.1', type: 'feature',     title: 'Notifications',                  desc: 'A working bell with overdue, due-today and due-tomorrow alerts, focus reminders, and optional browser notifications.' },
    { v: '2.0', type: 'feature',     title: 'Edit tasks · rename & reorder projects', desc: 'Edit any task’s details with the pencil, and rename or move your projects from the sidebar.' },
    { v: '1.9', type: 'feature',     title: 'Today’s Focus, supercharged',    desc: 'A live clock, “time left today”, rotating motivation quotes, and a distraction-free fullscreen focus mode.' },
    { v: '1.8', type: 'improvement', title: 'Clearer Focus Matrix',           desc: 'The dashboard matrix now explains each quadrant and lists your actual tasks — tap one to open its project.' },
    { v: '1.7', type: 'feature',     title: 'Time estimates',                 desc: 'Add an estimated time to any task and see how much work each project needs.' },
    { v: '1.6', type: 'feature',     title: 'Dark mode',                      desc: 'Switch between light and dark themes from the top bar.' },
    { v: '1.5', type: 'feature',     title: 'Google sign-in & cloud sync',    desc: 'Sign in to save your progress and sync it automatically across all your devices.' },
    { v: '1.0', type: 'feature',     title: 'Today’s Focus & dashboard',      desc: 'Pick up to 5 tasks from any project for today, and track real progress across everything on the dashboard.' },
  ];
  const CHANGELOG_VERSION = CHANGELOG[0].v;

  function renderChangelog() {
    const list = $('#changelogList');
    if (!list) return;
    const tags = {
      feature:     { label: 'New Feature', cls: 'cl-feature' },
      improvement: { label: 'Improvement', cls: 'cl-improvement' },
      fix:         { label: 'Fix',         cls: 'cl-fix' },
    };
    list.innerHTML = CHANGELOG.map((c) => {
      const t = tags[c.type] || tags.feature;
      return `
        <div class="cl-entry">
          <span class="cl-tag ${t.cls}">${t.label}</span>
          <p class="cl-body"><span class="cl-head">v${c.v} — ${escapeHTML(c.title)}.</span> <span class="cl-desc">${escapeHTML(c.desc)}</span></p>
        </div>`;
    }).join('');
  }

  function openChangelog() {
    renderChangelog();
    $('#changelogModal').classList.remove('hidden');
    try { localStorage.setItem('liyaa.changelogSeen', CHANGELOG_VERSION); } catch {}
    $('#whatsNewDot').classList.add('hidden');
  }
  function closeChangelog() { $('#changelogModal').classList.add('hidden'); }

  function syncWhatsNewDot() {
    let seen = null;
    try { seen = localStorage.getItem('liyaa.changelogSeen'); } catch {}
    $('#whatsNewDot').classList.toggle('hidden', seen === CHANGELOG_VERSION);
  }

  /* ============================================================
     SETTINGS  (custom quotes · cache reset · erase data · install)
     ============================================================ */
  function renderSettings() {
    const list = $('#customQuoteList');
    if (!list) return;

    // Build the full visible set: built-ins not hidden + custom.
    const hidden = new Set(state.hiddenQuotes || []);
    const entries = [];
    QUOTES.forEach((q, i) => { if (!hidden.has(i)) entries.push({ kind: 'builtin', idx: i, text: q.text, source: q.source }); });
    (state.customQuotes || []).forEach((q, i) => entries.push({ kind: 'custom', idx: i, text: q.text, source: (q.source ? q.source + ' · ' : '') + 'Your quote' }));

    const total = QUOTES.length + (state.customQuotes || []).length;
    const countEl = $('#quoteCount');
    if (countEl) countEl.textContent = `${entries.length} of ${total} active`;
    const restore = $('#restoreQuotesBtn');
    if (restore) restore.classList.toggle('hidden', hidden.size === 0);

    if (entries.length === 0) {
      list.innerHTML = '<p class="text-sm text-slate-400 py-2">No quotes are active. Add one above or restore the defaults.</p>';
    } else {
      list.innerHTML = '';
      entries.forEach((e) => {
        const row = document.createElement('div');
        row.className = 'flex items-start gap-3 p-3 rounded-xl bg-slate-50';
        const tag = e.kind === 'custom'
          ? '<span class="text-[10px] font-bold uppercase tracking-wide text-indigo-500 bg-indigo-100 px-1.5 py-0.5 rounded">yours</span>'
          : '';
        row.innerHTML = `
          <span class="text-indigo-400 text-lg leading-none shrink-0">“</span>
          <div class="min-w-0 flex-1">
            <p class="text-sm text-slate-700">${escapeHTML(e.text)}</p>
            <p class="text-xs text-slate-400 mt-1 flex items-center gap-1.5">${tag}<span>— ${escapeHTML(e.source)}</span></p>
          </div>
          <button class="shrink-0 w-8 h-8 grid place-items-center rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition" data-rm-kind="${e.kind}" data-rm-idx="${e.idx}" title="Remove" aria-label="Remove quote">
            <svg class="w-4 h-4 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
          </button>`;
        list.appendChild(row);
      });
    }
    syncInstallBtn();
  }

  function addCustomQuote(e) {
    e.preventDefault();
    const text = $('#quoteInput').value.trim();
    if (!text) return;
    const source = $('#quoteAuthor').value.trim();
    state.customQuotes.push({ text, source });
    save();
    $('#quoteInput').value = '';
    $('#quoteAuthor').value = '';
    renderSettings();
    renderQuote();
    toast('Quote added to your rotation');
  }

  function removeQuote(kind, idx) {
    if (kind === 'custom') {
      if (idx < 0 || idx >= state.customQuotes.length) return;
      state.customQuotes.splice(idx, 1);
    } else {
      if (!state.hiddenQuotes.includes(idx)) state.hiddenQuotes.push(idx);
    }
    save();
    renderSettings();
    renderQuote();
    toast('Quote removed');
  }

  function restoreDefaultQuotes() {
    state.hiddenQuotes = [];
    save();
    renderSettings();
    renderQuote();
    toast('Default quotes restored');
  }

  /* ---------- Backup: export / import ---------- */
  function exportData() {
    const json = JSON.stringify(state, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `liyaatodo-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Backup downloaded ✓');
  }

  function importData(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try { parsed = JSON.parse(reader.result); }
      catch { toast("That file isn't valid — couldn't read it"); return; }
      if (!parsed || !Array.isArray(parsed.projects) || !Array.isArray(parsed.tasks)) {
        toast("That doesn't look like a Liyaatodo backup");
        return;
      }
      setStateFrom(parsed);
      save();
      switchScreen('dashboard');
      render();
      toast('Backup restored ✓');
    };
    reader.onerror = () => toast('Could not read that file');
    reader.readAsText(file);
  }

  function resetCache() {
    if (!confirm('Clear the app cache and reload? Your tasks are kept.')) return;
    const done = () => window.location.reload();
    if ('caches' in window) {
      caches.keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .then(() => navigator.serviceWorker?.getRegistrations?.() || [])
        .then((regs) => Promise.all([...regs].map((r) => r.update().catch(() => {}))))
        .finally(done);
    } else { done(); }
  }

  /* ---------- Scoped erase (in-app confirm, no native dialogs) ---------- */
  let pendingErase = null;
  const ERASE_MSG = {
    tasks:    'Remove every task from every project? Your projects stay. This cannot be undone.',
    projects: 'Delete every project and its tasks, leaving one empty “General” project? This cannot be undone.',
    quotes:   'Remove all your custom quotes and restore the built-in ones to default?',
    all:      'Erase ALL data on this device AND in your cloud account (if signed in), then sign out? This cannot be undone.',
  };

  function showEraseOptions() {
    pendingErase = null;
    $('#eraseOptions').classList.remove('hidden');
    $('#eraseConfirm').classList.add('hidden');
    $('#eraseHeading').textContent = 'What would you like to erase?';
    $('#eraseSubheading').textContent = "Pick how much to clear. This can't be undone.";
  }
  function openEraseModal() { showEraseOptions(); $('#eraseModal').classList.remove('hidden'); }
  function closeEraseModal() { $('#eraseModal').classList.add('hidden'); pendingErase = null; }

  function askErase(what) {
    pendingErase = what;
    $('#eraseOptions').classList.add('hidden');
    $('#eraseConfirm').classList.remove('hidden');
    $('#eraseHeading').textContent = 'Are you sure?';
    $('#eraseSubheading').textContent = 'This cannot be undone.';
    $('#eraseConfirmMsg').textContent = ERASE_MSG[what] || '';
  }

  function runPendingErase() {
    const what = pendingErase;
    if (what === 'tasks') eraseTasksOnly();
    else if (what === 'projects') eraseProjectsAndTasks();
    else if (what === 'quotes') eraseQuotes();
    else if (what === 'all') eraseAllData();
  }

  function eraseTasksOnly() {
    state.tasks = [];
    state.todayTaskIds = [];
    save();
    render();
    closeEraseModal();
    toast('All tasks cleared');
  }

  function eraseProjectsAndTasks() {
    const general = { id: uid(), name: 'General' };
    state.projects = [general];
    state.activeProjectId = general.id;
    state.tasks = [];
    state.todayTaskIds = [];
    save();
    switchScreen('dashboard');
    render();
    closeEraseModal();
    toast('All projects and tasks deleted');
  }

  function eraseQuotes() {
    state.customQuotes = [];
    state.hiddenQuotes = [];
    save();
    renderSettings();
    renderQuote();
    closeEraseModal();
    toast('Quotes reset to default');
  }

  function eraseAllData() {
    const signedIn = Cloud.enabled && Cloud.user;
    const finish = () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem('liyaa.notified');
        localStorage.removeItem('liyaa.notifRead');
      } catch {}
      window.location.reload();
    };

    if (signedIn) {
      // Stop syncing so we don't re-push, delete the cloud doc, then sign out.
      if (Cloud.unsub) { Cloud.unsub(); Cloud.unsub = null; }
      Cloud.applying = true; // suppress any queued pushes
      userDoc(Cloud.user.uid).delete()
        .catch((err) => { console.error('Cloud delete failed:', err); toast('Could not delete cloud copy — check connection'); })
        .then(() => firebase.auth().signOut().catch(() => {}))
        .finally(finish);
    } else {
      finish();
    }
  }

  /* ---------- Install as an app (PWA) ---------- */
  let deferredInstallPrompt = null;

  function syncInstallBtn() {
    const btn = $('#installAppBtn');
    const hint = $('#installHint');
    if (!btn) return;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (standalone) {
      btn.disabled = true; btn.textContent = 'Already installed ✓';
      if (hint) hint.textContent = 'Liyaatodo is running as an installed app. 🎉';
    } else if (deferredInstallPrompt) {
      btn.disabled = false; btn.textContent = 'Install app';
    } else {
      btn.disabled = false; btn.textContent = 'How to install';
    }
  }

  function installApp() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.finally(() => { deferredInstallPrompt = null; syncInstallBtn(); });
    } else {
      // No native prompt (e.g. iOS Safari / already dismissed) — show guidance.
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
      toast(ios
        ? 'On iPhone: tap Share → “Add to Home Screen”'
        : 'Use your browser menu → “Install app” / “Add to Home Screen”');
    }
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

  // Active quotes = built-ins the user hasn't removed + their own custom ones.
  function allQuotes() {
    const hidden = new Set(state.hiddenQuotes || []);
    const builtin = QUOTES.filter((_, i) => !hidden.has(i));
    const custom = (state.customQuotes || []).map((q) => ({
      text: q.text, source: (q.source ? q.source + ' ' : '') + '✍️ Your quote', note: '',
    }));
    return builtin.concat(custom);
  }

  function renderQuote() {
    const el = $('#quoteText');
    if (!el) return;
    const list = allQuotes();
    if (list.length === 0) {
      el.textContent = '“Add a quote in Settings to see it here.”';
      $('#quoteSource').textContent = '— Liyaatodo';
      $('#quoteNote').classList.add('hidden');
      return;
    }
    const q = list[quoteIdx % list.length];
    el.textContent = `“${q.text}”`;
    $('#quoteSource').textContent = `— ${q.source}`;
    const noteEl = $('#quoteNote');
    if (q.note) { noteEl.textContent = q.note; noteEl.classList.remove('hidden'); }
    else { noteEl.classList.add('hidden'); }
  }

  function rotateQuote() {
    quoteIdx = (quoteIdx + 1) % (allQuotes().length || 1);
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
              ${labelChip(task)}
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
    $('#sortWrap').classList.toggle('invisible', isMatrix);
    if (isMatrix) renderMatrix();
    else renderTasks();
  }

  function renderTasks() {
    const listEl = $('#taskList');
    const proj = activeProject();
    let tasks = proj ? tasksFor(proj.id) : [];

    refreshLabelOptions();
    // Label filter banner
    const bar = $('#labelFilterBar');
    if (bar) {
      if (labelFilter) { bar.classList.remove('hidden'); $('#labelFilterName').textContent = labelFilter; }
      else bar.classList.add('hidden');
    }
    if (labelFilter) tasks = tasks.filter((t) => t.label === labelFilter);

    if (filter === 'active') tasks = tasks.filter((t) => !t.isCompleted);
    else if (filter === 'done') tasks = tasks.filter((t) => t.isCompleted);

    const prRank = { High: 0, Medium: 1, Low: 2 };
    const pos = new Map(state.tasks.map((t, i) => [t.id, i]));
    const byDeadline = (a, b) => (a.deadline || '9999-12-31').localeCompare(b.deadline || '9999-12-31');
    const cmp = {
      priority: (a, b) => (prRank[a.priority] - prRank[b.priority]) || byDeadline(a, b),
      deadline: (a, b) => byDeadline(a, b) || (prRank[a.priority] - prRank[b.priority]),
      estimate: (a, b) => ((b.estimateMin || 0) - (a.estimateMin || 0)) || (prRank[a.priority] - prRank[b.priority]),
      title:    (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      newest:   (a, b) => pos.get(b.id) - pos.get(a.id),
    };
    const sorter = cmp[sortBy] || cmp.priority;
    tasks = [...tasks].sort((a, b) => {
      if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1; // done always last
      return sorter(a, b);
    });

    listEl.innerHTML = '';
    const emptyEl = $('#emptyState');
    const totalForProject = proj ? tasksFor(proj.id).length : 0;

    if (tasks.length === 0) {
      emptyEl.classList.remove('hidden');
      $('#emptyStateText').textContent =
        labelFilter ? `No tasks labelled “${labelFilter}”`
        : totalForProject === 0 ? 'No tasks yet'
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
          ${labelChip(task)}
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

  function setLabelFilter(label) {
    labelFilter = label || '';
    if (view !== 'list') {
      view = 'list';
      $$('.seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === 'list'));
    }
    if (screen !== 'project') switchScreen('project');
    renderView();
  }

  function selectProject(id) {
    state.activeProjectId = id;
    filter = 'all';
    labelFilter = '';
    syncFilterChips();
    save();
    switchScreen('project');
    render();
    closeSidebar();
  }

  function addTask({ title, priority, deadline, urgent, important, estimateMin, label }) {
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
      label: (label || '').trim(),
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
    $('#editTaskLabel').value = task.label || '';
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
    task.label = $('#editTaskLabel').value.trim();
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
    $('#brandHome').addEventListener('click', () => { switchScreen('dashboard'); render(); });
    $('#brandHome').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchScreen('dashboard'); render(); }
    });
    $('#todayNav').addEventListener('click', () => { switchScreen('today'); renderToday(); renderSidebar(); });
    $('#guideNav').addEventListener('click', () => { switchScreen('guide'); renderSidebar(); });
    $('#guideStartBtn').addEventListener('click', () => { switchScreen('dashboard'); render(); });
    $('#settingsNav').addEventListener('click', () => { switchScreen('settings'); renderSettings(); renderSidebar(); });

    // --- Settings ---
    $('#addQuoteForm').addEventListener('submit', addCustomQuote);
    $('#customQuoteList').addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rm-kind]');
      if (rm) removeQuote(rm.dataset.rmKind, parseInt(rm.dataset.rmIdx, 10));
    });
    $('#restoreQuotesBtn').addEventListener('click', restoreDefaultQuotes);
    $('#exportDataBtn').addEventListener('click', exportData);
    $('#importDataInput').addEventListener('change', (e) => { importData(e.target.files[0]); e.target.value = ''; });
    $('#resetCacheBtn').addEventListener('click', resetCache);
    $('#installAppBtn').addEventListener('click', installApp);

    // --- Erase (scoped, two-step in-app confirm) ---
    $('#eraseDataBtn').addEventListener('click', openEraseModal);
    $('#eraseClose').addEventListener('click', closeEraseModal);
    $('#eraseOverlay').addEventListener('click', closeEraseModal);
    $('#eraseOptions').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-erase]');
      if (btn) askErase(btn.dataset.erase);
    });
    $('#eraseCancel').addEventListener('click', showEraseOptions);
    $('#eraseConfirmYes').addEventListener('click', runPendingErase);
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      syncInstallBtn();
    });
    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      syncInstallBtn();
      toast('🎉 Liyaatodo installed!');
    });

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
    $('#dashTodayFocus').addEventListener('click', () => { switchScreen('today'); renderToday(); renderSidebar(); });
    $('#dashHowTo').addEventListener('click', () => { switchScreen('guide'); renderSidebar(); });

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
        label: $('#taskLabel').value,
      });
      $('#taskTitle').value = '';
      $('#taskDeadline').value = defaultDeadline();
      $('#taskEstimate').value = '';
      $('#taskLabel').value = '';
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
        case 'filter-label':     setLabelFilter(action.dataset.label); break;
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
      if (action.dataset.action === 'filter-label') {
        const task = state.tasks.find((t) => t.id === id);
        if (task) { state.activeProjectId = task.projectId; setLabelFilter(action.dataset.label); }
      }
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
      if (e.key === 'Escape') { closeTaskPicker(); closeEditTask(); closeRenameProject(); closeNotifPanel(); closeEraseModal(); closeChangelog(); }
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

    // --- Sort ---
    $('#sortSelect').addEventListener('change', (e) => {
      sortBy = e.target.value;
      renderTasks();
    });

    // --- Clear label filter ---
    $('#labelFilterClear').addEventListener('click', () => { labelFilter = ''; renderTasks(); });

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
    $('#menuToggle').addEventListener('click', () => {
      if (window.innerWidth >= 1024) {
        // Desktop: collapse / expand the left bar (remembered).
        const collapsed = document.body.classList.toggle('sidebar-collapsed');
        try { localStorage.setItem('liyaa.sidebar', collapsed ? 'hidden' : 'shown'); } catch {}
      } else {
        // Mobile: toggle the slide-in drawer.
        if ($('#sidebar').classList.contains('-translate-x-full')) openSidebar();
        else closeSidebar();
      }
    });
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

    // --- What's new (changelog) ---
    $('#whatsNewBtn').addEventListener('click', openChangelog);
    $('#changelogClose').addEventListener('click', closeChangelog);
    $('#changelogOverlay').addEventListener('click', closeChangelog);

    // --- Notifications ---
    $('#notifBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleNotifPanel(); });
    $('#notifEnablePush').addEventListener('click', enablePushReminders);
    $('#notifMarkRead').addEventListener('click', (e) => { e.stopPropagation(); markAllNotifsRead(); });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#notifPanel') && !e.target.closest('#notifBtn')) closeNotifPanel();
    });

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

    // Restore collapsed-sidebar preference (desktop).
    try {
      if (localStorage.getItem('liyaa.sidebar') === 'hidden') document.body.classList.add('sidebar-collapsed');
    } catch {}

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

    // Show a dot on "What's new" if there's an unseen release.
    syncWhatsNewDot();

    // Deadline reminders: browser notifications (if allowed) + badge refresh.
    syncPushBtn();
    checkDeadlineReminders();
    setInterval(() => { checkDeadlineReminders(); renderNotifs(); }, 600000); // every 10 min

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
