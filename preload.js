const { contextBridge, ipcRenderer } = require('electron');

/**
 * Puente seguro entre el proceso de renderizado (UI) y el proceso principal.
 * Expone una API acotada `window.aulaControl` sin habilitar Node en el renderer.
 */
const VALID_EVENT_CHANNELS = new Set([
  'state-update',
  'chat-message',
  'radar-status',
  'student-list-update',
  'screen-frame-update',
  'webrtc-signal',
  'file-response',
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
  requestStudentList: () => ipcRenderer.invoke('request-student-list'),
  getDnsDomains: () => ipcRenderer.invoke('get-dns-state'),
  addDnsDomain: (domain) => ipcRenderer.invoke('add-dns-domain', domain),
  removeDnsDomain: (domain) => ipcRenderer.invoke('remove-dns-domain', domain),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  reportScreenCaptureError: (reason) => ipcRenderer.invoke('report-screen-capture-error', reason),
  sendWebrtcSignal: (targetSocketId, signal) =>
    ipcRenderer.invoke('send-webrtc-signal', { targetSocketId, signal }),
  fileCommand: (command) => ipcRenderer.invoke('file-command', command),
  broadcastFile: (localPath) => ipcRenderer.invoke('broadcast-file', localPath),

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
