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
  };
  let filter = 'all';    // all | active | done
  let view = 'list';     // list | matrix

  /* ---------- Utilities ---------- */
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // Robust-enough unique id without external deps.
  let _seq = 0;
  const uid = () => `${Date.now().toString(36)}-${(_seq++).toString(36)}-${performance.now().toString(36).replace('.', '')}`;

  const escapeHTML = (str) =>
    String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

  /* ---------- Persistence ---------- */
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.error('Failed to save state:', err);
      toast('⚠️ Could not save — storage may be full');
    }
  }

  function load() {
    let parsed = null;
    try {
      parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch { parsed = null; }

    if (parsed && Array.isArray(parsed.projects) && Array.isArray(parsed.tasks)) {
      state = {
        projects: parsed.projects,
        tasks: parsed.tasks,
        activeProjectId: parsed.activeProjectId ?? null,
      };
    }

    // Seed the default "General" project on first load.
    if (state.projects.length === 0) {
      const general = { id: uid(), name: 'General' };
      state.projects.push(general);
      state.activeProjectId = general.id;
      save();
    }

    // Guarantee a valid active project.
    if (!state.projects.some((p) => p.id === state.activeProjectId)) {
      state.activeProjectId = state.projects[0]?.id ?? null;
    }

    // Migrate older tasks that predate the Eisenhower fields.
    // Seed `important` from a High priority; default `urgent` to false.
    state.tasks.forEach((t) => {
      if (typeof t.important !== 'boolean') t.important = t.priority === 'High';
      if (typeof t.urgent !== 'boolean') t.urgent = false;
    });
  }

  /* ---------- Date helpers ---------- */
  const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

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
     RENDERING
     ============================================================ */

  function render() {
    renderProjects();
    renderHeader();
    renderProgress();
    renderView();
  }

  // Show either the List or the Matrix; only one is in the DOM flow at a time.
  function renderView() {
    const isMatrix = view === 'matrix';
    $('#taskList').classList.toggle('hidden', isMatrix);
    $('#emptyState').classList.toggle('hidden', isMatrix);   // matrix has its own per-quadrant empties
    $('#matrixView').classList.toggle('hidden', !isMatrix);
    $('#filterChips').classList.toggle('invisible', isMatrix); // filters only apply to the list
    if (isMatrix) renderMatrix();
    else renderTasks();
  }

  function renderProjects() {
    const list = $('#projectList');
    list.innerHTML = '';

    state.projects.forEach((proj) => {
      const tasks = tasksFor(proj.id);
      const total = tasks.length;
      const done = tasks.filter((t) => t.isCompleted).length;
      const pct = total === 0 ? 0 : Math.round((done / total) * 100);
      const isActive = proj.id === state.activeProjectId;

      const btn = document.createElement('button');
      btn.className = 'project-item' + (isActive ? ' is-active' : '');
      btn.dataset.id = proj.id;
      btn.innerHTML = `
        <span class="proj-main">
          <span class="project-dot"></span>
          <span class="proj-name truncate">${escapeHTML(proj.name)}</span>
          <span class="proj-count">${total}</span>
          <span class="proj-del" title="Delete project" data-action="del-project" data-id="${proj.id}">
            <svg class="w-4 h-4 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
          </span>
        </span>
        <span class="proj-bar" title="${done}/${total} completed (${pct}%)">
          <span class="proj-bar-fill" style="width:${pct}%"></span>
        </span>`;
      list.appendChild(btn);
    });

    $('#projectCount').textContent = `${state.projects.length}`;
  }

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
    }
    $('#activeProjectMeta').textContent = meta;

    // Don't allow deleting the very last project.
    $('#deleteProjectBtn').disabled = state.projects.length <= 1;
    $('#deleteProjectBtn').classList.toggle('opacity-40', state.projects.length <= 1);
    $('#deleteProjectBtn').classList.toggle('pointer-events-none', state.projects.length <= 1);
  }

  function renderProgress() {
    const proj = activeProject();
    const tasks = proj ? tasksFor(proj.id) : [];
    const total = tasks.length;
    const done = tasks.filter((t) => t.isCompleted).length;

    // Edge case: 0 tasks → 0% (no division by zero).
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);

    $('#progressBar').style.width = pct + '%';
    $('#progressPercentLabel').textContent = pct + '%';
    $('#progressRing').style.setProperty('--pct', pct);
    $('#progressCountLabel').textContent = `${done} of ${total} task${total === 1 ? '' : 's'} completed`;

    let sub;
    if (total === 0) sub = 'Add a task to get started';
    else if (pct === 100) sub = '🎉 All done — great work!';
    else if (pct >= 50) sub = 'Over halfway there!';
    else sub = 'Let’s build some momentum.';
    $('#progressSubLabel').textContent = sub;
  }

  function renderTasks() {
    const listEl = $('#taskList');
    const proj = activeProject();
    let tasks = proj ? tasksFor(proj.id) : [];

    // Apply filter.
    if (filter === 'active') tasks = tasks.filter((t) => !t.isCompleted);
    else if (filter === 'done') tasks = tasks.filter((t) => t.isCompleted);

    // Sort: incomplete first, then by priority (High→Low), then by deadline (soonest first).
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
          ${dueHTML}
        </div>
      </div>
      <button class="task-tag ${task.important ? 'on-imp' : ''}" data-action="toggle-important" title="${task.important ? 'Important' : 'Mark important'}" aria-pressed="${task.important}">★</button>
      <button class="task-tag ${task.urgent ? 'on-urg' : ''}" data-action="toggle-urgent" title="${task.urgent ? 'Urgent' : 'Mark urgent'}" aria-pressed="${task.urgent}">⚡</button>
      <button class="task-del" data-action="delete" title="Delete task" aria-label="Delete task">
        <svg class="w-4 h-4 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6"/></svg>
      </button>`;
    return row;
  }

  /* ---------- Eisenhower Matrix ---------- */
  const QUADRANTS = [
    { key: 'do',       cls: 'do',       icon: '🟢', title: 'Do',       sub: 'Important · Urgent',         imp: true,  urg: true  },
    { key: 'schedule', cls: 'schedule', icon: '🟠', title: 'Schedule', sub: 'Important · Not urgent',     imp: true,  urg: false },
    { key: 'delegate', cls: 'delegate', icon: '🔵', title: 'Delegate', sub: 'Not important · Urgent',     imp: false, urg: true  },
    { key: 'del',      cls: 'del',      icon: '🔴', title: 'Delete',   sub: 'Not important · Not urgent', imp: false, urg: false },
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
     ACTIONS (each one persists)
     ============================================================ */

  function addProject(name) {
    name = name.trim();
    if (!name) return;
    const proj = { id: uid(), name };
    state.projects.push(proj);
    state.activeProjectId = proj.id;
    save();
    render();
    toast(`Project “${name}” created`);
  }

  function deleteProject(id) {
    if (state.projects.length <= 1) return;
    const proj = state.projects.find((p) => p.id === id);
    if (!proj) return;
    const taskCount = tasksFor(id).length;
    const msg = taskCount > 0
      ? `Delete “${proj.name}” and its ${taskCount} task${taskCount === 1 ? '' : 's'}?`
      : `Delete project “${proj.name}”?`;
    if (!confirm(msg)) return;

    state.projects = state.projects.filter((p) => p.id !== id);
    state.tasks = state.tasks.filter((t) => t.projectId !== id);
    if (state.activeProjectId === id) state.activeProjectId = state.projects[0].id;
    save();
    render();
    toast('Project deleted');
  }

  function selectProject(id) {
    if (state.activeProjectId === id) return;
    state.activeProjectId = id;
    filter = 'all';
    syncFilterChips();
    save();
    render();
    closeSidebar();
  }

  function addTask({ title, priority, deadline, urgent, important }) {
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

  // Re-tag a task to match a quadrant (used by drag-and-drop).
  function moveTaskToQuadrant(id, quadKey) {
    const task = state.tasks.find((t) => t.id === id);
    const q = QUADRANTS.find((x) => x.key === quadKey);
    if (!task || !q) return;
    if (task.important === q.imp && task.urgent === q.urg) return; // no change
    task.important = q.imp;
    task.urgent = q.urg;
    save();
    render();
    toast(`Moved to “${q.title}”`);
  }

  /* ---------- Pointer-based drag & drop (mouse + touch) ---------- */
  function setupMatrixDnD() {
    const grid = $('#matrixView');
    let drag = null;          // { id, row, ghost, startX, startY, active }
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
      // Floating ghost follows the pointer; pointer-events:none so hit-testing sees the quad beneath.
      const r = drag.row.getBoundingClientRect();
      const ghost = drag.row.cloneNode(true);
      ghost.classList.add('drag-ghost');
      ghost.style.width = r.width + 'px';
      drag.offX = drag.startX - r.left;
      drag.offY = drag.startY - r.top;
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      drag.row.classList.add('dragging');
      document.body.classList.add('dnd-active'); // disables touch-scroll / text selection
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
        if (moved > 6) arm();                 // mouse: small move starts the drag
      } else if (moved > 14) {
        teardown(false);                       // touch: moved before hold fired → it's a scroll, bail out
      }
    };
    const onUp = (e) => teardown(true, e.clientX, e.clientY);
    const onCancel = () => teardown(false);

    grid.addEventListener('pointerdown', (e) => {
      if (e.button && e.button !== 0) return;          // ignore right/middle click
      const row = e.target.closest('.task-row');
      if (!row) return;
      if (e.target.closest('[data-action]')) return;   // taps on checkbox / chips / delete stay taps
      drag = { id: row.dataset.id, row, ghost: null, startX: e.clientX, startY: e.clientY, active: false, pointerType: e.pointerType };
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      if (e.pointerType !== 'mouse') holdTimer = setTimeout(arm, 180); // touch: long-press to lift
    });
  }

  function deleteTask(id) {
    state.tasks = state.tasks.filter((t) => t.id !== id);
    save();
    render();
  }

  /* ============================================================
     EVENT WIRING
     ============================================================ */

  function bindEvents() {
    // Add project
    $('#addProjectForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#newProjectInput');
      addProject(input.value);
      input.value = '';
    });

    // Project list (event delegation: select + delete)
    $('#projectList').addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-action="del-project"]');
      if (delBtn) { e.stopPropagation(); deleteProject(delBtn.dataset.id); return; }
      const item = e.target.closest('.project-item');
      if (item) selectProject(item.dataset.id);
    });

    // Delete active project (header button)
    $('#deleteProjectBtn').addEventListener('click', () => {
      if (state.activeProjectId) deleteProject(state.activeProjectId);
    });

    // New-task Eisenhower toggles (Important / Urgent)
    [['#newImportant'], ['#newUrgent']].forEach(([sel]) => {
      $(sel).addEventListener('click', () => {
        const btn = $(sel);
        btn.dataset.on = btn.dataset.on === 'true' ? 'false' : 'true';
      });
    });

    // Add task
    $('#addTaskForm').addEventListener('submit', (e) => {
      e.preventDefault();
      addTask({
        title: $('#taskTitle').value,
        priority: $('#taskPriority').value,
        deadline: $('#taskDeadline').value,
        important: $('#newImportant').dataset.on === 'true',
        urgent: $('#newUrgent').dataset.on === 'true',
      });
      $('#taskTitle').value = '';
      $('#taskDeadline').value = '';
      $('#newImportant').dataset.on = 'false';
      $('#newUrgent').dataset.on = 'false';
      $('#taskTitle').focus();
    });

    // Task interactions — shared across List and Matrix containers.
    const handleTaskClick = (e) => {
      const action = e.target.closest('[data-action]');
      if (!action) return;
      const row = e.target.closest('.task-row');
      if (!row) return;
      const id = row.dataset.id;
      switch (action.dataset.action) {
        case 'toggle':           toggleTask(id); break;
        case 'delete':           deleteTask(id); break;
        case 'toggle-important': toggleTaskFlag(id, 'important'); break;
        case 'toggle-urgent':    toggleTaskFlag(id, 'urgent'); break;
      }
    };
    $('#taskList').addEventListener('click', handleTaskClick);
    $('#matrixView').addEventListener('click', handleTaskClick);

    // Drag & drop between matrix quadrants — pointer-based (works for mouse AND touch)
    setupMatrixDnD();

    // View switch (List / Matrix)
    $$('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (view === btn.dataset.view) return;
        view = btn.dataset.view;
        $$('.seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
        renderView();
      });
    });

    // Filters
    $$('.filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        filter = chip.dataset.filter;
        syncFilterChips();
        renderTasks();
      });
    });

    // Mobile sidebar
    $('#menuToggle').addEventListener('click', openSidebar);
    $('#backdrop').addEventListener('click', closeSidebar);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });

    // Keep multiple tabs in sync.
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) { load(); render(); }
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
    if (window.innerWidth >= 1024) return; // lg: sidebar is static
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
    render();

    // Default deadline picker minimum = today (still allows clearing).
    const todayISO = new Date().toISOString().slice(0, 10);
    $('#taskDeadline').setAttribute('min', '1970-01-01'); // allow any; min kept loose intentionally
    $('#taskDeadline').value = '';

    // Register service worker for PWA/offline.
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {/* offline reg optional */});
      });
    }

    void todayISO;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
