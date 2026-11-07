const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * Puente seguro entre el proceso de renderizado (UI) y el proceso principal.
 * Expone una API acotada `window.aulaControl` sin habilitar Node en el renderer.
 */
const VALID_EVENT_CHANNELS = new Set([
  'sync-global-state',
  'chat-message',
  'radar-status',
  'student-list-update',
  'screen-frame-update',
  'student-live-frame',
  'live-watch-start',
  'live-watch-stop',
  'teacher-lower-hand',
  'file-response',
  'file-chunk',
  'file-chunk-end',
  'file-broadcast-received',
  'screen-capture-error',
  'dns-command-result'
]);

contextBridge.exposeInMainWorld('aulaControl', {
  // ---------- Invocaciones (renderer -> main) ----------
  getInitialState: () => ipcRenderer.invoke('get-initial-state'),
  login: (username, password) => ipcRenderer.invoke('login', { username, password }),
  logout: () => ipcRenderer.invoke('logout'),
  sendChat: (text) => ipcRenderer.invoke('send-chat', text),
  raiseHand: (raised) => ipcRenderer.invoke('raise-hand', raised),
  lowerHand: (studentSocketId) => ipcRenderer.invoke('lower-hand', studentSocketId),
  requestStudentList: () => ipcRenderer.invoke('request-student-list'),
  getDnsDomains: () => ipcRenderer.invoke('get-dns-state'),
  addDnsDomain: (domain) => ipcRenderer.invoke('add-dns-domain', domain),
  removeDnsDomain: (domain) => ipcRenderer.invoke('remove-dns-domain', domain),
  reapplyDnsRules: (targetSocketId) => ipcRenderer.invoke('reapply-dns-rules', { targetSocketId }),
  assignCustomName: (instanceId, customName) =>
    ipcRenderer.invoke('assign-custom-name', { instanceId, customName }),
  updateConfig: (cfg) => ipcRenderer.invoke('update-config', cfg),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  reportScreenCaptureError: (reason) => ipcRenderer.invoke('report-screen-capture-error', reason),
  sendThumbnailFrame: (dataUrl) => ipcRenderer.invoke('send-thumbnail-frame', dataUrl),
  sendLiveFrame: (dataUrl) => ipcRenderer.invoke('send-live-frame', dataUrl),
  openStudentScreenWindow: (socketId, hostname) =>
    ipcRenderer.invoke('open-student-screen-window', { socketId, hostname }),
  fileCommand: (command) => ipcRenderer.invoke('file-command', command),
  saveDownloadedFile: (filename, data) => ipcRenderer.invoke('save-downloaded-file', { filename, data }),
  broadcastFile: (payload) => ipcRenderer.invoke('broadcast-file', payload),
  selectPaths: () => ipcRenderer.invoke('select-paths'),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // ---------- Suscripción a eventos (main -> renderer) ----------
  // Devuelve una función para cancelar la suscripción.
  on: (channel, callback) => {
    if (!VALID_EVENT_CHANNELS.has(channel)) {
      throw new Error(`Canal de evento no permitido: ${channel}`);
    }
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
