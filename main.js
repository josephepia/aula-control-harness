const { app, BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
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
let screenTimer = null;     // Temporizador de miniaturas de pantalla (estudiante)
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
// Captura de miniaturas de pantalla (estudiante, cada ~2 segundos)
// ---------------------------------------------------------------------------
function startScreenThumbnails() {
  stopScreenThumbnails();

  screenTimer = setInterval(async () => {
    if (!studentSocket || !studentSocket.connected) {
      return;
    }

    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 320, height: 180 }
      });

      if (sources.length > 0) {
        const dataUrl = sources[0].thumbnail.toDataURL();
        studentSocket.emit('student-screen-frame', { dataUrl });
      }
    } catch (err) {
      // La captura puede fallar sin bloquear la aplicación.
    }
  }, 2000);
}

function stopScreenThumbnails() {
  if (screenTimer) {
    clearInterval(screenTimer);
    screenTimer = null;
  }
}

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
      const dirPath = data.path || os.homedir();
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
      response.result = await fs.promises.readFile(data.path, 'utf8');
    } else if (data.action === 'write') {
      if (!data.path) {
        throw new Error('Ruta de archivo no especificada.');
      }
      await fs.promises.writeFile(data.path, data.content || '', 'utf8');
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
// Transiciones de rol
// ---------------------------------------------------------------------------
function startStudentMode() {
  role = 'student';

  // Detener artefactos del modo maestro.
  stopScreenThumbnails();
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
  stopScreenThumbnails();

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
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 320, height: 180 }
      });
      return sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnailDataUrl: source.thumbnail ? source.thumbnail.toDataURL() : null
      }));
    } catch (err) {
      console.error('[main] Error al obtener fuentes de pantalla:', err.message);
      return [];
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
        content: command.content
      });
      return { success: true, requestId };
    }

    return { success: false, error: 'Solo disponible en modo maestro.' };
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
  stopScreenThumbnails();
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
