'use strict';
/* Persistent local pane sizing. Separators operate on text/UI only; no network. */
(function (global) {
  const STORAGE_KEY = 'layoutPreferences';
  const controllers = [];
  const knownKeys = new Set(['history-list', 'history-messages', 'intercept', 'repeater', 'decoder', 'comparer-inputs', 'comparer-result', 'inspector', 'inspector-messages', 'runner-plan', 'runner-results', 'collections', 'collection-sidebar', 'websocket', 'builder']);
  let preferences = { version: 1, splits: {} };
  let writeChain = Promise.resolve();
  let readyResolve;
  const pendingRefreshes = new Set();
  let refreshFrame = null;
  let refreshTimer = null;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function scheduleRefresh(controller) {
    if (!controller.view.classList.contains('active')) return;
    pendingRefreshes.add(controller);
    if (refreshFrame != null) return;
    const flush = () => {
      if (refreshFrame == null) return;
      cancelAnimationFrame(refreshFrame);
      clearTimeout(refreshTimer);
      refreshFrame = null;
      refreshTimer = null;
      // Read every visible container before changing styles to avoid repeatedly
      // laying out long raw responses while switching tools or resizing.
      const updates = [...pendingRefreshes].map((item) => ({ item, sizing: item.measure() }));
      pendingRefreshes.clear();
      for (const { item, sizing } of updates) item.apply(sizing);
    };
    // Background extension tabs may not receive animation frames. The timer
    // also covers a tab that becomes hidden after an animation frame is queued.
    refreshFrame = requestAnimationFrame(flush);
    refreshTimer = setTimeout(flush, 50);
  }

  function refreshVisible() {
    for (const controller of controllers) scheduleRefresh(controller);
  }

  function normalize(input) {
    if (!input || input.version !== 1 || !input.splits || typeof input.splits !== 'object' || Array.isArray(input.splits)) return { version: 1, splits: {} };
    const splits = {};
    for (const [key, axes] of Object.entries(input.splits)) {
      if (!knownKeys.has(key) || !axes || typeof axes !== 'object') continue;
      const values = {};
      for (const axis of ['x', 'y']) if (Number.isFinite(axes[axis])) values[axis] = clamp(axes[axis], 20, 80);
      if (Object.keys(values).length) splits[key] = values;
    }
    return { version: 1, splits };
  }

  function capture() {
    return JSON.parse(JSON.stringify(preferences));
  }

  function save() {
    const snapshot = capture();
    writeChain = writeChain.catch(() => {}).then(() => chrome.storage.local.set({ [STORAGE_KEY]: snapshot }));
    return writeChain;
  }

  async function restore(input) {
    await ready;
    preferences = normalize(input);
    refreshVisible();
    await save();
  }

  async function reset() {
    await restore({ version: 1, splits: {} });
    const status = document.getElementById('layoutStatus');
    if (status) status.textContent = 'All pane sizes reset.';
  }

  function record(controller, ratio) {
    preferences.splits[controller.key] ||= {};
    preferences.splits[controller.key][controller.axis] = Math.round(ratio * 100) / 100;
    if (controller.dragging) {
      const { axis, bounds } = controller.dragging;
      controller.apply({ axis, bounds, actual: clamp(ratio, bounds.min, bounds.max) });
    } else controller.refresh();
  }

  function createSplit(key, container, label, defaults = { x: 50, y: 50 }) {
    if (!container || container.children.length !== 2) return;
    const [first, second] = container.children;
    const divider = document.createElement('div');
    divider.className = 'pane-divider';
    divider.tabIndex = 0;
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-label', label);
    divider.title = 'Drag to resize · Arrow keys to adjust · Double-click to reset';
    divider.dataset.layoutKey = key;
    first.id ||= `layout-${key}-first`;
    second.id ||= `layout-${key}-second`;
    divider.setAttribute('aria-controls', `${first.id} ${second.id}`);
    container.classList.add('resizable-panes');
    container.dataset.layoutKey = key;
    first.classList.add('resizable-pane'); second.classList.add('resizable-pane');
    container.insertBefore(divider, second);
    const controller = {
      key, container, first, second, divider, view: container.closest('.view'), axis: 'x', defaults, dragging: null,
      measure() {
        const axis = getComputedStyle(container).flexDirection.startsWith('column') ? 'y' : 'x';
        const ratio = preferences.splits[key]?.[axis] ?? defaults[axis] ?? 50;
        const bounds = this.bounds(axis);
        const actual = clamp(ratio, bounds.min, bounds.max);
        return { axis, actual, bounds };
      },
      apply({ axis, actual, bounds }) {
        this.axis = axis;
        const firstFlex = `${actual} 1 0px`, secondFlex = `${100 - actual} 1 0px`;
        if (first.style.flex !== firstFlex) first.style.setProperty('flex', firstFlex, 'important');
        if (second.style.flex !== secondFlex) second.style.setProperty('flex', secondFlex, 'important');
        if (divider.dataset.axis !== axis) divider.dataset.axis = axis;
        const attributes = {
          'aria-orientation': axis === 'x' ? 'vertical' : 'horizontal',
          'aria-valuemin': String(Math.round(bounds.min)), 'aria-valuemax': String(Math.round(bounds.max)),
          'aria-valuenow': String(Math.round(actual)), 'aria-valuetext': `${Math.round(actual)} percent for the first pane`,
        };
        for (const [name, value] of Object.entries(attributes)) if (divider.getAttribute(name) !== value) divider.setAttribute(name, value);
      },
      refresh() { this.apply(this.measure()); },
      bounds(axis = this.axis) {
        const box = container.getBoundingClientRect();
        const length = (axis === 'x' ? box.width : box.height) - 8;
        const minimum = axis === 'x' ? 120 : 80;
        const margin = length > 0 ? Math.min(45, minimum / length * 100) : 20;
        return { min: Math.max(20, margin), max: Math.min(80, 100 - margin) };
      },
    };
    controllers.push(controller);
    divider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || controller.dragging) return;
      event.preventDefault();
      controller.refresh();
      divider.focus({ preventScroll: true });
      const coordinate = controller.axis === 'x' ? event.clientX : event.clientY;
      const dividerBox = divider.getBoundingClientRect();
      const dividerStart = controller.axis === 'x' ? dividerBox.left : dividerBox.top;
      const parentBox = container.getBoundingClientRect();
      const length = (controller.axis === 'x' ? parentBox.width : parentBox.height) - 8;
      const start = controller.axis === 'x' ? parentBox.left : parentBox.top;
      controller.dragging = { id: event.pointerId, offset: coordinate - dividerStart, axis: controller.axis, start, length, bounds: controller.bounds() };
      divider.setPointerCapture(event.pointerId);
      document.body.classList.add('pane-resizing');
      document.body.dataset.resizeAxis = controller.axis;
    });
    divider.addEventListener('pointermove', (event) => {
      if (controller.dragging?.id !== event.pointerId) return;
      const { axis, start, length, offset, bounds } = controller.dragging;
      if (length <= 0) return;
      const position = (axis === 'x' ? event.clientX : event.clientY) - start - offset;
      record(controller, clamp(position / length * 100, bounds.min, bounds.max));
    });
    const finish = (event) => {
      if (controller.dragging?.id !== event.pointerId) return;
      controller.dragging = null;
      document.body.classList.remove('pane-resizing');
      delete document.body.dataset.resizeAxis;
      if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
      save().catch(() => {});
    };
    divider.addEventListener('pointerup', finish);
    divider.addEventListener('pointercancel', finish);
    divider.addEventListener('lostpointercapture', finish);
    divider.addEventListener('keydown', (event) => {
      controller.refresh();
      const decrease = controller.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      const increase = controller.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      if (![decrease, increase, 'Home', 'End', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      const ratio = preferences.splits[key]?.[controller.axis] ?? defaults[controller.axis] ?? 50;
      const bounds = controller.bounds();
      const value = event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : event.key === 'Enter' ? defaults[controller.axis] ?? 50 : ratio + (event.key === increase ? 1 : -1) * (event.shiftKey ? 10 : 2);
      record(controller, clamp(value, bounds.min, bounds.max)); save().catch(() => {});
    });
    divider.addEventListener('dblclick', () => {
      if (preferences.splits[key]) delete preferences.splits[key][controller.axis];
      if (preferences.splits[key] && !Object.keys(preferences.splits[key]).length) delete preferences.splits[key];
      controller.refresh(); save().catch(() => {});
    });
    new ResizeObserver(() => scheduleRefresh(controller)).observe(container);
    controller.refresh();
  }

  function groupPairs(container, count, className) {
    if (!container || container.children.length < count + 1) return null;
    const elements = [...container.children];
    const first = document.createElement('div'), second = document.createElement('div');
    first.className = second.className = 'layout-inner-pane';
    for (const element of elements.slice(0, count)) first.append(element);
    for (const element of elements.slice(count)) second.append(element);
    container.append(first, second); container.classList.add(className);
    return container;
  }

  async function init() {
    try { preferences = normalize((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]); } catch { /* default sizes */ }
    const find = (selector) => document.querySelector(selector);
    createSplit('history-list', find('.history-layout'), 'Resize HTTP History list and message details', { x: 45, y: 45 });
    createSplit('history-messages', find('#view-history .split2'), 'Resize History request and response');
    createSplit('intercept', find('.intercept-split'), 'Resize Intercept queue and editor', { x: 28, y: 32 });
    createSplit('repeater', find('#view-repeater .split2'), 'Resize Repeater request and response');
    createSplit('decoder', find('#view-decoder .split2'), 'Resize Decoder input and output');
    createSplit('comparer-inputs', find('.compare-inputs'), 'Resize Comparer Side A and Side B');
    const comparerInputs = find('.compare-inputs'), comparerResult = find('.compare-result');
    if (comparerInputs && comparerResult) {
      const wrapper = document.createElement('div'); wrapper.className = 'layout-comparer-results grow';
      comparerInputs.before(wrapper); wrapper.append(comparerInputs, comparerResult);
      createSplit('comparer-result', wrapper, 'Resize Comparer inputs and line diff', { x: 36, y: 36 });
    }
    createSplit('inspector', find('#view-inspector .workflow-split'), 'Resize Inspector inputs and fields', { x: 40, y: 50 });
    createSplit('inspector-messages', groupPairs(find('.inspector-input'), 2, 'layout-inspector-messages'), 'Resize Inspector request and response');
    createSplit('runner-plan', find('.runner-plan'), 'Resize Runner request template and payloads', { x: 68, y: 60 });
    createSplit('runner-results', find('.runner-results'), 'Resize Runner result list and response');
    createSplit('collections', find('#view-collections .workflow-split'), 'Resize Collections sidebar and saved request', { x: 28, y: 40 });
    createSplit('collection-sidebar', groupPairs(find('.collection-sidebar'), 3, 'layout-collection-sidebar'), 'Resize Collections request list and variables', { x: 50, y: 55 });
    createSplit('websocket', find('#view-websocket .workflow-split'), 'Resize WebSocket frame list and payload');
    createSplit('builder', find('#view-builder > .lab-grid.grow'), 'Resize API Builder form and response');
    // A breakpoint can change direction without changing a hidden container's
    // observed dimensions. Update the axis on resize and when its view opens.
    window.addEventListener('resize', refreshVisible);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshVisible(); });
    for (const breakpoint of [580, 760, 820, 900]) matchMedia(`(max-width:${breakpoint}px)`).addEventListener('change', refreshVisible);
    const viewObserver = new MutationObserver((mutations) => {
      const activeViews = new Set(mutations.map((mutation) => mutation.target).filter((view) => view.classList.contains('active')));
      for (const controller of controllers) if (activeViews.has(controller.view)) scheduleRefresh(controller);
    });
    for (const view of document.querySelectorAll('main > .view')) viewObserver.observe(view, { attributes: true, attributeFilter: ['class'] });
    document.getElementById('layoutReset')?.addEventListener('click', () => reset().catch(() => {}));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[STORAGE_KEY]) return;
      preferences = normalize(changes[STORAGE_KEY].newValue);
      for (const controller of controllers) if (!controller.dragging) scheduleRefresh(controller);
    });
    readyResolve();
  }

  global.Layout = { capture, restore, reset, ready, keys: [...knownKeys] };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(window);
