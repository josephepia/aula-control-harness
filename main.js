const { app, BrowserWindow, desktopCapturer, ipcMain, screen, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const { io } = require('socket.io-client');

const {
  RadarBroadcaster,
  RadarListener,
  getLocalIPv4Addresses,
  MASTER_PORT
} = require('./src/shared/radar');
const MasterServer = require('./src/shared/server');

// ---------------------------------------------------------------------------
// Identidad de la instancia (única por arranque)
// ---------------------------------------------------------------------------
const instanceId = crypto.randomUUID();
const hostname = os.hostname();
const localIps = getLocalIPv4Addresses();

// Credenciales del Maestro (según memoria de arquitectura)
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

// ---------------------------------------------------------------------------
// Estado de la aplicación
// ---------------------------------------------------------------------------
let mainWindow = null;
let role = 'student'; // 'student' | 'teacher'

let radarListener = null;   // Modo estudiante: descubre al maestro
let radarBroadcaster = null; // Modo maestro: anuncia su presencia
let masterServer = null;    // Modo maestro: servidor Express + Socket.io
let studentSocket = null;   // Modo estudiante: cliente socket.io hacia el maestro
let connectedMasterUrl = null; // URL del maestro al que está conectado el estudiante

const chatHistory = [];
const MAX_CHAT_HISTORY = 200;

// Dominios bloqueados en la sesión actual del maestro (refleja el archivo hosts).
const blockedDomains = new Set();

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function pushToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function getPublicState() {
  return {
    instanceId,
    hostname,
    role,
    localIps,
    chatHistory: chatHistory.slice()
  };
}

function appendChatMessage(message) {
  chatHistory.push(message);
  if (chatHistory.length > MAX_CHAT_HISTORY) {
    chatHistory.shift();
  }
  pushToRenderer('chat-message', message);
}

// ---------------------------------------------------------------------------
// Bloqueo DNS (modificación del archivo hosts del sistema operativo)
// ---------------------------------------------------------------------------
function hostsFilePath() {
  return process.platform === 'win32'
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    : '/etc/hosts';
}

/**
 * Vacía la caché DNS del sistema operativo tras modificar el archivo hosts.
 * Windows: `ipconfig /flushdns` · macOS: `dscacheutil -flushcache` + reinicio de mDNSResponder.
 */
function flushDnsCache() {
  let command = null;
  if (process.platform === 'win32') {
    command = 'ipconfig /flushdns';
  } else if (process.platform === 'darwin') {
    command = 'dscacheutil -flushcache; killall -HUP mDNSResponder';
  }

  if (!command) {
    return; // Linux/otros: sin comando estándar, se omite.
  }

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error('[dns] Error al vaciar la caché DNS:', error.message);
    } else if (stderr) {
      console.warn('[dns] Aviso al vaciar la caché DNS:', stderr.trim());
    }
  });
}

async function applyDnsBlock(domain) {
  try {
    const filePath = hostsFilePath();
    const content = await fs.promises.readFile(filePath, 'utf8');
    const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const alreadyBlocked = content
      .split('\n')
      .some((line) => line.includes('127.0.0.1') && line.includes(domain));

    if (alreadyBlocked) {
      return { success: true, message: `El dominio ${domain} ya estaba bloqueado.` };
    }

    const entry = `127.0.0.1 ${domain}\n`;
    await fs.promises.appendFile(filePath, entry);
    flushDnsCache();
    return { success: true, message: `Dominio ${domain} bloqueado.` };
  } catch (err) {
    return { success: false, error: `No se pudo bloquear ${domain}: ${err.message}` };
  }
}

async function removeDnsBlock(domain) {
  try {
    const filePath = hostsFilePath();
    const content = await fs.promises.readFile(filePath, 'utf8');

    const filtered = content
      .split('\n')
      .filter((line) => !(line.includes('127.0.0.1') && line.includes(domain)))
      .join('\n');

    await fs.promises.writeFile(filePath, filtered, 'utf8');
    flushDnsCache();
    return { success: true, message: `Bloqueo de ${domain} removido.` };
  } catch (err) {
    return { success: false, error: `No se pudo desbloquear ${domain}: ${err.message}` };
  }
}

/**
 * Normaliza un dominio ingresado por el usuario:
 * elimina espacios, protocolo (http/https) y rutas.
 */
function normalizeDomain(domain) {
  return String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

function getBlockedDomains() {
  return Array.from(blockedDomains);
}

/**
 * Bloquea un dominio: lo escribe en hosts, lo registra en memoria y
 * propaga la orden a todos los estudiantes conectados.
 */
async function addBlockedDomain(domain) {
  const result = await applyDnsBlock(domain);
  if (result.success) {
    blockedDomains.add(domain);
    if (masterServer) {
      masterServer.io.emit('execute-dns-command', { action: 'block', domain });
    }
  }
  return { ...result, domains: getBlockedDomains() };
}

/**
 * Desbloquea un dominio: lo quita de hosts, lo elimina de memoria y
 * propaga la orden a todos los estudiantes conectados.
 */
async function removeBlockedDomain(domain) {
  const result = await removeDnsBlock(domain);
  if (result.success) {
    blockedDomains.delete(domain);
    if (masterServer) {
      masterServer.io.emit('execute-dns-command', { action: 'unblock', domain });
    }
  }
  return { ...result, domains: getBlockedDomains() };
}

// ---------------------------------------------------------------------------
// Captura de miniaturas de pantalla
// ---------------------------------------------------------------------------
// Las miniaturas de la grilla se generan ahora en el RENDERER del estudiante:
// el stream de pantalla se dibuja en un <canvas> y se convierte a JPEG de
// calidad media; el fotograma llega aquí vía IPC 'send-thumbnail-frame' y se
// reenvía por socket.io. Ver `src/ui/app.js` (captura de fondo) y el handler
// 'send-thumbnail-frame' más abajo.

// ---------------------------------------------------------------------------
// Conexión del estudiante al Maestro (socket.io-client)
// ---------------------------------------------------------------------------
function connectToMaster(masterIp, masterPort) {
  const url = `http://${masterIp}:${masterPort}`;

  // Si ya está conectado al mismo maestro, no se reconecta.
  if (connectedMasterUrl === url && studentSocket && studentSocket.connected) {
    return;
  }

  if (studentSocket) {
    studentSocket.removeAllListeners();
    studentSocket.disconnect();
    studentSocket = null;
  }

  connectedMasterUrl = url;

  studentSocket = io(url, {
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000
  });

  studentSocket.on('connect', () => {
    pushToRenderer('radar-status', { status: 'connected', masterIp, masterPort });

    studentSocket.emit('register-student', {
      instanceId,
      hostname,
      ip: localIps[0] || '127.0.0.1',
      role: 'student'
    });
  });

  studentSocket.on('register-rejected', () => {
    // Nuestro propio anuncio fue rechazado: se evita el bucle.
    studentSocket.disconnect();
    connectedMasterUrl = null;
    pushToRenderer('radar-status', { status: 'searching' });
  });

  studentSocket.on('chat-message', (message) => {
    appendChatMessage(message);
  });

  studentSocket.on('execute-dns-command', async (command) => {
    if (!command || !command.domain) {
      return;
    }
    const result = command.action === 'unblock'
      ? await removeDnsBlock(command.domain)
      : await applyDnsBlock(command.domain);
    pushToRenderer('dns-command-result', { ...command, ...result });
  });

  studentSocket.on('webrtc-signal', (data) => {
    pushToRenderer('webrtc-signal', {
      fromSocketId: data.fromSocketId,
      signal: data.signal
    });
  });

  studentSocket.on('file-command', async (data) => {
    await handleIncomingFileCommand(data);
  });

  studentSocket.on('broadcast-file', async (payload) => {
    await handleIncomingBroadcast(payload);
  });

  studentSocket.on('disconnect', () => {
    connectedMasterUrl = null;
    pushToRenderer('radar-status', { status: 'searching' });
  });

  studentSocket.on('connect_error', () => {
    connectedMasterUrl = null;
    pushToRenderer('radar-status', { status: 'searching' });
  });
}

// ---------------------------------------------------------------------------
// Gestor de archivos remotos (estudiante ejecuta comandos fs locales)
// ---------------------------------------------------------------------------
/**
 * Resuelve una ruta proveniente del Maestro contra el directorio personal del
 * estudiante. Evita resolver rutas relativas contra el directorio del proyecto
 * (causa de errores ENOENT).
 */
function resolveStudentPath(userPath) {
  if (!userPath) {
    return os.homedir();
  }
  return path.isAbsolute(userPath) ? userPath : path.join(os.homedir(), userPath);
}

async function handleIncomingFileCommand(data) {
  if (!data || !data.action) {
    return;
  }

  const response = {
    requestId: data.requestId,
    action: data.action,
    targetSocketId: 'teacher'
  };

  try {
    if (data.action === 'list') {
      const dirPath = resolveStudentPath(data.path);
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      response.result = entries
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          isSymbolicLink: entry.isSymbolicLink()
        }))
        .sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });
    } else if (data.action === 'read') {
      if (!data.path) {
        throw new Error('Ruta de archivo no especificada.');
      }
      response.result = await fs.promises.readFile(resolveStudentPath(data.path), 'utf8');
    } else if (data.action === 'write') {
      if (!data.path) {
        throw new Error('Ruta de archivo no especificada.');
      }
      await fs.promises.writeFile(resolveStudentPath(data.path), data.content || '', 'utf8');
      response.result = 'ok';
    } else if (data.action === 'download') {
      if (!data.path) {
        throw new Error('Ruta de archivo no especificada.');
      }
      const filePath = resolveStudentPath(data.path);
      const buffer = await fs.promises.readFile(filePath);
      response.result = {
        filename: path.basename(filePath),
        data: buffer.toString('base64')
      };
    } else if (data.action === 'upload') {
      if (!data.filename) {
        throw new Error('Nombre de archivo no especificado.');
      }
      const targetDir = resolveStudentPath(data.path || '');
      const targetPath = path.join(targetDir, data.filename);
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.writeFile(targetPath, Buffer.from(data.data || '', 'base64'));
      response.result = 'ok';
    } else {
      throw new Error(`Acción desconocida: ${data.action}`);
    }
  } catch (err) {
    response.error = err.message;
  }

  if (studentSocket && studentSocket.connected) {
    studentSocket.emit('file-response', response);
  }
}

// ---------------------------------------------------------------------------
// Difusión masiva de archivos (Maestro -> todos los estudiantes)
// ---------------------------------------------------------------------------
/**
 * Lee de forma recursiva un archivo o carpeta local y devuelve un payload
 * listo para emitir por socket.io (cada archivo en base64).
 */
async function buildBroadcastPayload(paths) {
  const files = [];

  for (const p of paths) {
    const resolved = path.resolve(p);
    const stat = await fs.promises.stat(resolved);

    if (stat.isFile()) {
      const data = await fs.promises.readFile(resolved);
      files.push({ relPath: path.basename(resolved), data: data.toString('base64') });
    } else if (stat.isDirectory()) {
      await collectDirectoryFiles(resolved, resolved, files);
    } else {
      throw new Error(`La ruta "${resolved}" no es ni un archivo ni un directorio.`);
    }
  }

  return { files };
}

async function collectDirectoryFiles(root, dir, files) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectDirectoryFiles(root, full, files);
    } else if (entry.isFile()) {
      const data = await fs.promises.readFile(full);
      files.push({
        relPath: path.relative(root, full),
        data: data.toString('base64')
      });
    }
  }
}

/**
 * Escribe en el estudiante los archivos recibidos por difusión masiva,
 * siempre bajo `os.homedir()/AulaControl/recibidos/<nombre>`.
 */
async function handleIncomingBroadcast(payload) {
  if (!payload || !Array.isArray(payload.files)) {
    return;
  }

  const destRel = String(payload.destination || '').trim();
  const baseDir = destRel
    ? path.join(os.homedir(), destRel)
    : path.join(os.homedir(), 'AulaControl', 'recibidos');
  let written = 0;
  const errors = [];

  for (const file of payload.files) {
    const targetPath = path.join(baseDir, file.relPath);
    try {
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.writeFile(targetPath, Buffer.from(file.data, 'base64'));
      written += 1;
    } catch (err) {
      errors.push(`${file.relPath}: ${err.message}`);
    }
  }

  pushToRenderer('file-broadcast-received', {
    success: errors.length === 0,
    written,
    total: payload.files.length,
    destDir: baseDir,
    error: errors.length ? errors.join('; ') : null
  });
}

// ---------------------------------------------------------------------------
// Transiciones de rol
// ---------------------------------------------------------------------------
function startStudentMode() {
  role = 'student';

  // Detener artefactos del modo maestro.
  if (radarBroadcaster) {
    radarBroadcaster.stop();
    radarBroadcaster = null;
  }
  if (masterServer) {
    masterServer.stop();
    masterServer = null;
  }

  // Iniciar listener de radar UDP.
  if (radarListener) {
    radarListener.stop();
  }
  radarListener = new RadarListener({
    instanceId,
    onMasterDiscovered: (masterInfo) => {
      pushToRenderer('radar-status', {
        status: 'discovered',
        masterIp: masterInfo.ip,
        masterPort: masterInfo.port
      });
      connectToMaster(masterInfo.ip, masterInfo.port);
    }
  });
  radarListener.start();

  pushToRenderer('radar-status', { status: 'searching' });
}

function startTeacherMode() {
  role = 'teacher';

  // Detener artefactos del modo estudiante.
  if (radarListener) {
    radarListener.stop();
    radarListener = null;
  }
  if (studentSocket) {
    studentSocket.removeAllListeners();
    studentSocket.disconnect();
    studentSocket = null;
  }
  connectedMasterUrl = null;

  // Iniciar servidor maestro (Express + Socket.io en puerto 3000).
  masterServer = new MasterServer({ instanceId, port: MASTER_PORT });

  masterServer.on('student-list', (list) => {
    pushToRenderer('student-list-update', list);
  });
  masterServer.on('chat-message', (message) => {
    appendChatMessage(message);
  });
  masterServer.on('screen-frame', (frame) => {
    pushToRenderer('screen-frame-update', frame);
  });
  masterServer.on('webrtc-signal', (signal) => {
    pushToRenderer('webrtc-signal', {
      fromSocketId: signal.fromSocketId,
      signal: signal.signal
    });
  });
  masterServer.on('file-response', (response) => {
    pushToRenderer('file-response', response);
  });
  masterServer.on('screen-capture-error', (payload) => {
    pushToRenderer('screen-capture-error', payload);
  });

  masterServer.start().catch((err) => {
    console.error('[main] No se pudo iniciar el servidor maestro:', err.message);
  });

  // Iniciar emisor de radar UDP broadcast.
  radarBroadcaster = new RadarBroadcaster({ instanceId });
  radarBroadcaster.start();
}

// ---------------------------------------------------------------------------
// IPC (comunicación con la interfaz de usuario)
// ---------------------------------------------------------------------------
function registerIpcHandlers() {
  ipcMain.handle('get-initial-state', () => getPublicState());

  ipcMain.handle('login', (event, credentials) => {
    const username = credentials?.username;
    const password = credentials?.password;

    if (username === ADMIN_USER && password === ADMIN_PASS) {
      startTeacherMode();
      return { success: true, role: 'teacher' };
    }
    return { success: false, error: 'Credenciales incorrectas.' };
  });

  ipcMain.handle('logout', () => {
    startStudentMode();
    return { success: true, role: 'student' };
  });

  ipcMain.handle('send-chat', (event, text) => {
    const cleanText = String(text || '').trim();
    if (!cleanText) {
      return { success: false, error: 'Mensaje vacío.' };
    }

    const message = {
      id: `${Date.now()}-local`,
      sender: hostname,
      text: cleanText,
      timestamp: Date.now()
    };

    if (role === 'teacher' && masterServer) {
      // El maestro transmite a todos los estudiantes conectados.
      masterServer.io.emit('chat-message', message);
      appendChatMessage(message);
    } else if (role === 'student' && studentSocket && studentSocket.connected) {
      studentSocket.emit('send-chat-message', message);
    } else {
      appendChatMessage(message);
    }

    return { success: true };
  });

  ipcMain.handle('raise-hand', (event, raised) => {
    if (role === 'student' && studentSocket && studentSocket.connected) {
      studentSocket.emit('raise-hand', { raised: Boolean(raised) });
      return { success: true };
    }
    return { success: false, error: 'No conectado al maestro.' };
  });

  ipcMain.handle('request-student-list', () => {
    if (role === 'teacher' && masterServer) {
      // Fuerza la re-emisión manual de la lista.
      masterServer._emitStudentList();
      return { success: true, students: masterServer.getStudentList() };
    }
    return { success: false, students: [] };
  });

  ipcMain.handle('get-dns-state', () => {
    return { domains: getBlockedDomains() };
  });

  ipcMain.handle('add-dns-domain', async (event, rawDomain) => {
    const domain = normalizeDomain(rawDomain);
    if (!domain) {
      return { success: false, error: 'Dominio no especificado.' };
    }
    if (role !== 'teacher' || !masterServer) {
      return { success: false, error: 'Solo disponible en modo maestro.' };
    }
    return await addBlockedDomain(domain);
  });

  ipcMain.handle('remove-dns-domain', async (event, rawDomain) => {
    const domain = normalizeDomain(rawDomain);
    if (!domain) {
      return { success: false, error: 'Dominio no especificado.' };
    }
    if (role !== 'teacher' || !masterServer) {
      return { success: false, error: 'Solo disponible en modo maestro.' };
    }
    return await removeBlockedDomain(domain);
  });

  // ---------- Captura de pantalla (desktopCapturer de Electron) ----------
  ipcMain.handle('get-screen-sources', async () => {
    try {
      const primaryDisplayId = screen.getPrimaryDisplay().id;
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 320, height: 180 }
      });

      // Ordena la pantalla principal activa al inicio y marca cada fuente.
      const mapped = sources
        .map((source) => ({
          id: source.id,
          name: source.name,
          displayId: source.display_id,
          isPrimary: source.display_id === primaryDisplayId,
          thumbnailDataUrl: source.thumbnail && source.thumbnail.getSize().width > 0
            ? source.thumbnail.toDataURL()
            : null
        }))
        .sort((a, b) => (a.isPrimary === b.isPrimary ? 0 : (a.isPrimary ? -1 : 1)));

      if (mapped.length === 0) {
        return {
          sources: [],
          error: 'No se detectaron pantallas. Revisa el permiso de grabación de pantalla del sistema operativo.'
        };
      }

      return { sources: mapped, primaryDisplayId };
    } catch (err) {
      console.error('[main] Error al obtener fuentes de pantalla:', err.message);
      return {
        sources: [],
        error: 'No se pudo acceder a la captura de pantalla. Revisa el permiso de grabación de pantalla del sistema operativo.'
      };
    }
  });

  // ---------- Streaming WebRTC ----------
  ipcMain.handle('send-webrtc-signal', (event, payload) => {
    const targetSocketId = payload?.targetSocketId;
    const signal = payload?.signal;

    if (!targetSocketId || signal === undefined) {
      return { success: false, error: 'Señal incompleta.' };
    }

    if (role === 'teacher' && masterServer) {
      // El maestro envía su señal a un estudiante concreto.
      masterServer.io.to(targetSocketId).emit('webrtc-signal', {
        fromSocketId: 'teacher',
        signal
      });
      return { success: true };
    }

    if (role === 'student' && studentSocket && studentSocket.connected) {
      // El estudiante responde su señal al maestro (id virtual 'teacher').
      studentSocket.emit('webrtc-signal', {
        targetSocketId: 'teacher',
        signal
      });
      return { success: true };
    }

    return { success: false, error: 'No hay conexión activa.' };
  });

  // ---------- Gestor de archivos remotos ----------
  ipcMain.handle('file-command', (event, command) => {
    const targetSocketId = command?.targetSocketId;
    const action = command?.action;
    const requestId = command?.requestId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (!targetSocketId || !action) {
      return { success: false, error: 'Comando incompleto.' };
    }

    if (role === 'teacher' && masterServer) {
      masterServer.io.to(targetSocketId).emit('file-command', {
        fromSocketId: 'teacher',
        requestId,
        action,
        path: command.path,
        content: command.content,
        filename: command.filename,
        data: command.data
      });
      return { success: true, requestId };
    }

    return { success: false, error: 'Solo disponible en modo maestro.' };
  });

  // ---------- Difusión masiva de archivos (Maestro -> todos los estudiantes) ----------
  ipcMain.handle('broadcast-file', async (event, payload) => {
    const paths = (payload && Array.isArray(payload.paths)) ? payload.paths : [];
    const destination = String((payload && payload.destination) || '').trim();

    if (paths.length === 0) {
      return { success: false, error: 'No se seleccionaron archivos o carpetas.' };
    }
    if (role !== 'teacher' || !masterServer) {
      return { success: false, error: 'Solo disponible en modo maestro.' };
    }

    try {
      const broadcastPayload = await buildBroadcastPayload(paths);
      const studentCount = masterServer.connectedStudents.size;
      if (studentCount === 0) {
        return { success: false, error: 'No hay estudiantes conectados.' };
      }
      masterServer.io.emit('broadcast-file', {
        destination,
        files: broadcastPayload.files
      });
      return {
        success: true,
        files: broadcastPayload.files.length,
        students: studentCount,
        destination
      };
    } catch (err) {
      return { success: false, error: `No se pudo leer la ruta: ${err.message}` };
    }
  });

  // ---------- Selección de rutas (archivos/carpetas) para difusión masiva ----------
  ipcMain.handle('select-paths', async () => {
    if (role !== 'teacher') {
      return { success: false, paths: [] };
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar archivos o carpetas',
      properties: ['openFile', 'openDirectory', 'multiSelections']
    });
    if (result.canceled) {
      return { success: false, paths: [] };
    }
    return { success: true, paths: result.filePaths };
  });

  // ---------- Guardar archivo descargado en la carpeta de descargas ----------
  ipcMain.handle('save-to-downloads', async (event, payload) => {
    const filename = path.basename(String((payload && payload.filename) || 'archivo'));
    const data = (payload && payload.data) || '';
    if (!data) {
      return { success: false, error: 'Sin datos para guardar.' };
    }
    try {
      const downloadsDir = app.getPath('downloads');
      const targetPath = path.join(downloadsDir, filename);
      await fs.promises.writeFile(targetPath, Buffer.from(data, 'base64'));
      return { success: true, path: targetPath };
    } catch (err) {
      return { success: false, error: `No se pudo guardar: ${err.message}` };
    }
  });

  // ---------- Miniatura de pantalla generada en el renderer (canvas/JPEG) ----------
  ipcMain.handle('send-thumbnail-frame', (event, dataUrl) => {
    if (role === 'student' && studentSocket && studentSocket.connected) {
      studentSocket.emit('student-screen-frame', { dataUrl: String(dataUrl || '') });
      return { success: true };
    }
    return { success: false, error: 'No hay conexión activa.' };
  });

  // ---------- Reporte de error de captura de pantalla (estudiante -> maestro) ----------
  ipcMain.handle('report-screen-capture-error', (event, reason) => {
    if (role === 'student' && studentSocket && studentSocket.connected) {
      studentSocket.emit('screen-capture-error', {
        reason: String(reason || 'Error de captura de pantalla.')
      });
      return { success: true };
    }
    return { success: false, error: 'No hay conexión activa.' };
  });
}

// ---------------------------------------------------------------------------
// Ciclo de vida de Electron
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'Aula Control',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'ui', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerIpcHandlers();
  startStudentMode();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (radarListener) {
    radarListener.stop();
  }
  if (radarBroadcaster) {
    radarBroadcaster.stop();
  }
  if (studentSocket) {
    studentSocket.removeAllListeners();
    studentSocket.disconnect();
  }
  if (masterServer) {
    masterServer.stop();
  }
});
