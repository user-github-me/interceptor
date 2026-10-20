'use strict';
/* Shared local-data disclosure. No testing data is read before UI acceptance. */
(function (global) {
  const REVISION = 1;
  const STORAGE_KEY = 'localDataDisclosure';
  let pending;
  async function accepted() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      return data[STORAGE_KEY]?.revision === REVISION && typeof data[STORAGE_KEY]?.acceptedAt === 'string' && Number.isFinite(Date.parse(data[STORAGE_KEY].acceptedAt));
    } catch { return false; }
  }
  async function acknowledge() {
    await chrome.storage.local.set({ [STORAGE_KEY]: { revision: REVISION, acceptedAt: new Date().toISOString() } });
  }
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function policyLink() {
    const link = element('a', 'Privacy policy');
    link.href = 'https://github.com/user-github-me/interceptor/blob/main/PRIVACY.md';
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    return link;
  }
  async function requireDisclosure(options = {}) {
    if (await accepted()) return true;
    if (pending) return pending;
    pending = new Promise((resolve) => {
      const dialog = element('dialog', '', 'disclosure-dialog');
      dialog.setAttribute('aria-labelledby', 'disclosureTitle');
      const title = element('h1', 'Your testing work stays in this browser profile'); title.id = 'disclosureTitle';
      dialog.append(title,
        element('p', 'Interceptor automatically saves selected HTTP/WebSocket traffic, requests, responses, drafts, variables, and authentication fields on this PC. Saved data can include cookies, tokens, passwords, and personal information.'),
        element('p', 'The developer does not receive your testing data. Requests you start, forward, or automatically rewrite go to the testing targets you choose. Passive review and imports send no requests.'),
        element('p', 'The local database is not separately encrypted by Interceptor. Workspace offers full backup, optional backup encryption, restore, and undo. Clear history and delete requests or environments in their tools. Downloaded files and the restore undo copy are separate copies.'),
        policyLink());
      const error = element('p', '', 'disclosure-error'); error.setAttribute('role', 'alert');
      const actions = element('div', '', 'disclosure-actions');
      const continueButton = element('button', 'Continue and save locally', 'primary');
      const closeButton = element('button', options.closeLabel || 'Close workbench');
      actions.append(continueButton, closeButton);
      if (options.recover) {
        const recover = element('button', 'Download existing saved work');
        recover.addEventListener('click', async () => {
          recover.disabled = true; error.textContent = '';
          try { await options.recover(); }
          catch (e) { error.textContent = `Recovery failed: ${e.message}`; }
          finally { recover.disabled = false; }
        });
        dialog.append(element('p', 'Already have a saved workspace? Download it without starting new capture or replacing it.', 'hint'), recover);
      }
      dialog.append(error, actions);
      function finish(value) { dialog.close(); dialog.remove(); pending = null; resolve(value); }
      continueButton.addEventListener('click', async () => {
        continueButton.disabled = true; error.textContent = '';
        try { await acknowledge(); finish(true); }
        catch (e) { error.textContent = `Could not save your choice: ${e.message}. Testing has not started.`; continueButton.disabled = false; }
      });
      closeButton.addEventListener('click', () => { finish(false); global.close(); });
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeButton.click(); });
      document.body.append(dialog); dialog.showModal(); continueButton.focus();
    });
    return pending;
  }
  function showHelp() {
    const dialog = element('dialog', '', 'disclosure-dialog help-dialog');
    dialog.setAttribute('aria-labelledby', 'helpTitle');
    const title = element('h1', 'Start with your app'); title.id = 'helpTitle';
    const list = element('ol');
    for (const text of ["Select your app’s tab and Attach. Chrome’s debugging banner is expected: it grants the access used to capture and edit traffic.", 'Turn Intercept ON, use your app, then edit and Forward or Drop a paused request. Detach to release paused traffic and stop recording.', 'Send a request to Repeater or build one in API Builder. Sending starts traffic to your selected URL; HTTP is unencrypted. Runner repeats up to 50 requests and can be stopped.', 'Auto mode is configured in the toolbar popup. Check the tab scope and URL include/exclude rules before enabling it. A blank include list permits all HTTP(S) URLs in that scope.', 'Security Review and Site Map inspect recorded traffic. Observations need context and manual verification; imports and passive tools do not send requests.']) list.append(element('li', text));
    dialog.append(title, list, element('h2', 'Local data and permissions'),
      element('p', 'Your workspace saves automatically in this browser profile, including credentials and frame previews. The database is not separately encrypted. Workspace downloads full backups with optional password encryption and offers validated restore with undo. Backup files remain where you downloaded them.'),
      element('p', 'Debugger access captures and edits selected traffic. Host access supports your chosen test sites and API endpoints. Local storage retains work and settings. Temporary header rules reproduce custom request headers; clipboard access powers Copy buttons.'), policyLink());
    const docs = element('a', 'Documentation and support'); docs.href = 'https://github.com/user-github-me/interceptor'; docs.target = '_blank'; docs.rel = 'noopener noreferrer'; dialog.append(docs);
    const actions = element('div', '', 'disclosure-actions'); const close = element('button', 'Close help', 'primary');
    close.addEventListener('click', () => { dialog.close(); dialog.remove(); });
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); close.click(); });
    actions.append(close); dialog.append(actions); document.body.append(dialog); dialog.showModal(); close.focus();
  }
  const api = { REVISION, STORAGE_KEY, accepted, ready: accepted, acknowledge, require: requireDisclosure, showHelp };
  global.Disclosure = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
