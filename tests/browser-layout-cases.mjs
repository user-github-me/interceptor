import assert from 'node:assert/strict';

// Shared by the real extension integration harness. Uses CDP pointer input,
// reloads the page, and restores the caller's layout and viewport afterwards.
export async function runLayoutCases({ call, evaluate, until }) {
  await until('typeof Layout !== "undefined" && typeof labState !== "undefined" && labState.ready');
  await evaluate('Layout.ready');
  const original = await evaluate('Layout.capture()');
  const viewport = await evaluate('({width:innerWidth,height:innerHeight})');
  const pause = () => new Promise((resolve) => setTimeout(resolve, 80));
  async function geometry(key) {
    // Media emulation and ResizeObserver deliveries can span multiple frames
    // after reopening a view containing long previews. Wait for its accessible
    // separator axis to agree with the actual computed layout before input.
    await until(`(()=>{const divider=document.querySelector('.pane-divider[data-layout-key=${JSON.stringify(key)}]');return divider && divider.dataset.axis === (getComputedStyle(divider.parentElement).flexDirection.startsWith('column')?'y':'x')})()`);
    return evaluate(`(()=>{const divider=document.querySelector('.pane-divider[data-layout-key=${JSON.stringify(key)}]');const parent=divider.parentElement.getBoundingClientRect();const first=divider.previousElementSibling.getBoundingClientRect();const box=divider.getBoundingClientRect();return {axis:divider.dataset.axis,value:Number(divider.getAttribute('aria-valuenow')),orientation:divider.getAttribute('aria-orientation'),parent:{x:parent.x,y:parent.y,width:parent.width,height:parent.height},first:{width:first.width,height:first.height},box:{x:box.x,y:box.y,width:box.width,height:box.height}}})()`);
  }
  async function drag(key, ratio) {
    const before = await geometry(key);
    const x = before.box.x + before.box.width / 2, y = before.box.y + before.box.height / 2;
    const targetX = before.axis === 'x' ? before.parent.x + (before.parent.width - 8) * ratio / 100 + 4 : x;
    const targetY = before.axis === 'y' ? before.parent.y + (before.parent.height - 8) * ratio / 100 + 4 : y;
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetX, y: targetY, button: 'left', buttons: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: targetX, y: targetY, button: 'left', clickCount: 1 });
    await pause();
    const after = await geometry(key);
    assert.ok(Math.abs(after.value - ratio) <= 2, `${key} drag changes ratio to ${ratio}: ${after.value}`);
    assert.ok(Math.abs((after.axis === 'x' ? after.first.width : after.first.height) - (before.axis === 'x' ? before.first.width : before.first.height)) > 15, `${key} actually resizes its pane`);
    await until(`chrome.storage.local.get('layoutPreferences').then(data=>Math.abs(data.layoutPreferences.splits[${JSON.stringify(key)}]?.[${JSON.stringify(after.axis)}]-${ratio})<2)`);
    return after;
  }
  try {
    await call('Page.bringToFront');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
    await evaluate('Layout.reset()');
    await evaluate('switchView("history")'); await pause();
    await until('innerWidth >= 1435 && document.querySelector(".pane-divider[data-layout-key=history-messages]").dataset.axis === "x"');
    assert.equal(await evaluate('document.querySelectorAll(".pane-divider").length'), 15);
    assert.equal((await geometry('history-list')).orientation, 'horizontal');
    assert.equal((await geometry('history-messages')).orientation, 'vertical');
    await drag('history-list', 60); await drag('history-messages', 65);
    await evaluate('flushLocalSave()');
    await call('Page.reload');
    await until('typeof Layout !== "undefined" && typeof labState !== "undefined" && labState.ready && document.readyState === "complete"');
    await call('Page.bringToFront');
    await evaluate('Layout.ready'); await evaluate('switchView("history")'); await pause();
    assert.ok(Math.abs((await geometry('history-list')).value - 60) < 2, 'history list ratio survives reload');
    assert.ok(Math.abs((await geometry('history-messages')).value - 65) < 2, 'request/response ratio survives reload');

    await evaluate('(()=>{const divider=document.querySelector(".pane-divider[data-layout-key=history-messages]");divider.focus();divider.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))})()');
    assert.ok(Math.abs((await geometry('history-messages')).value - 63) < 2, 'keyboard arrows resize');
    await evaluate('document.querySelector(".pane-divider[data-layout-key=history-messages]").dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true}))');
    assert.equal((await geometry('history-messages')).value, 20);
    await evaluate('document.querySelector(".pane-divider[data-layout-key=history-messages]").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
    assert.equal((await geometry('history-messages')).value, 50);

    const desktopViews = {
      intercept: ['intercept'], repeater: ['repeater'], decoder: ['decoder'],
      comparer: ['comparer-inputs', 'comparer-result'], inspector: ['inspector', 'inspector-messages'],
      runner: ['runner-plan', 'runner-results'], collections: ['collections', 'collection-sidebar'],
      websocket: ['websocket'], builder: ['builder'],
    };
    for (const [view, keys] of Object.entries(desktopViews)) {
      await evaluate(`switchView(${JSON.stringify(view)})`); await pause();
      for (const key of keys) {
        const box = await geometry(key);
        assert.ok(box.box.width > 0 && box.box.height > 0, `${key} is visible`);
        await drag(key, box.value < 50 ? 55 : 45);
        assert.equal(await evaluate(`document.querySelector('.pane-divider[data-layout-key=${JSON.stringify(key)}]').getAttribute('role')`), 'separator');
      }
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, `${view} desktop layout fits`);
    }

    await call('Emulation.setDeviceMetricsOverride', { width: 760, height: 1050, deviceScaleFactor: 1, mobile: false });
    await evaluate('switchView("history")'); await pause();
    assert.equal((await geometry('history-messages')).axis, 'y', 'request/response stack changes drag axis');
    await drag('history-messages', 60);
    const preferences = await evaluate('Layout.capture()');
    assert.ok(Math.abs(preferences.splits['history-messages'].y - 60) < 2);
    assert.equal(preferences.splits['history-messages'].x, undefined, 'double-click cleared only the desktop preference');
    for (const view of ['history', 'repeater', 'decoder', 'comparer', 'inspector', 'runner', 'collections', 'websocket', 'builder']) {
      await evaluate(`switchView(${JSON.stringify(view)})`); await pause();
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, `${view} stacked layout fits`);
    }
    await call('Emulation.setDeviceMetricsOverride', { width: 530, height: 1050, deviceScaleFactor: 1, mobile: false });
    await evaluate('switchView("intercept")'); await pause();
    assert.equal((await geometry('intercept')).axis, 'y', 'queue stacks and drag follows its vertical axis');
    await drag('intercept', 55);
    await evaluate('Layout.restore({version:1,splits:{repeater:{x:200},unknown:{x:40}}})');
    assert.deepEqual(await evaluate('Layout.capture()'), { version: 1, splits: { repeater: { x: 80 } } }, 'restore clamps ratios and ignores unknown panes');
    await evaluate('switchView("workspace");document.querySelector("#layoutReset").click()');
    await until('chrome.storage.local.get("layoutPreferences").then(data=>Object.keys(data.layoutPreferences.splits).length===0)');
    assert.deepEqual(await evaluate('Layout.capture()'), { version: 1, splits: {} });
  } catch (error) {
    console.error('Layout failure geometry:', await evaluate('({width:innerWidth,view:document.querySelector(".view.active").id,flex:getComputedStyle(document.querySelector("#view-history .split2")).flexDirection,axis:document.querySelector(".pane-divider[data-layout-key=history-messages]").dataset.axis,viewport:visualViewport.width})'));
    throw error;
  } finally {
    await evaluate(`Layout.restore(${JSON.stringify(original)})`);
    await call('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
    await evaluate('switchView("history")');
  }
  console.log('PASS: draggable pane dividers in every split view, actual pane resizing, keyboard/reset, reload persistence, stacked axes, clamped restore, narrow layouts.');
}
