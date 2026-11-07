const http = require('http');
const { EventEmitter } = require('events');
const express = require('express');
const { Server } = require('socket.io');

const { MASTER_PORT, getLocalIPv4Addresses } = require('./radar');

/**
 * Servidor Maestro (Express + Socket.io).
 *
 * Corre únicamente en el proceso del Maestro, en el puerto 3000.
 * Mantiene el Map reactivo `connectedStudents` en memoria y emite de forma
 * proactiva el evento `update-student-list` ante cualquier cambio.
 *
 * Extiende EventEmitter para notificar al proceso principal (main.js) los
 * eventos que deben reenviarse a la interfaz del Maestro:
 *   - 'student-list'      (array completo de estudiantes)
 *   - 'chat-message'      (mensaje de chat)
 *   - 'screen-frame'      (miniatura de pantalla de un estudiante)
 *   - 'webrtc-signal'     (señal WebRTC dirigida al Maestro)
 *   - 'file-command'      (comando de gestor de archivos del Maestro)
 *   - 'file-response'     (respuesta de un estudiante al Maestro)
 *   - 'screen-capture-error' (error de captura de pantalla de un estudiante)
 */
class MasterServer extends EventEmitter {
  constructor({ instanceId, port = MASTER_PORT }) {
    super();
    this.instanceId = instanceId;
    this.port = port;

    this.app = express();
    this.httpServer = http.createServer(this.app);
    this.io = new Server(this.httpServer, {
      cors: { origin: '*' }
    });

    // Map reactivo en memoria: clave socket.id -> datos del estudiante.
    this.connectedStudents = new Map();

    this._setupRoutes();
    this._setupSockets();
  }

  /**
   * Determina si un registro proviene de esta misma máquina/instancia.
   * Se usa para el auto-filtro que evita que el Maestro se conecte a sí mismo.
   */
  _isSelf(instanceId, ip) {
    if (instanceId && instanceId === this.instanceId) {
      return true;
    }
    if (ip && getLocalIPv4Addresses().includes(ip)) {
      return true;
    }
    return false;
  }

  _setupRoutes() {
    this.app.get('/health', (req, res) => {
      res.json({
        ok: true,
        service: 'AULA_CONTROL_MASTER',
        instanceId: this.instanceId,
        students: this.connectedStudents.size
      });
    });
  }

  _setupSockets() {
    this.io.on('connection', (socket) => {
      // ---------- Registro de estudiante ----------
      socket.on('register-student', (data = {}) => {
        const ip = data.ip || socket.handshake.address;

        if (this._isSelf(data.instanceId, ip)) {
          // Auto-filtro: se ignora el registro de nuestra propia instancia/IP.
          socket.emit('register-rejected', { reason: 'self' });
          return;
        }

        const student = {
          socketId: socket.id,
          instanceId: data.instanceId || null,
          hostname: data.hostname || 'Desconocido',
          ip,
          role: 'student',
          handRaised: false,
          screenFrame: null,
          connectedAt: Date.now()
        };

        this.connectedStudents.set(socket.id, student);
        socket.emit('register-accepted');
        this._emitStudentList();
      });

      // ---------- Solicitud manual de lista (Maestro -> Servidor) ----------
      socket.on('request-student-list', () => {
        socket.emit('update-student-list', this.getStudentList());
      });

      // ---------- Alzar la mano ----------
      socket.on('raise-hand', (data = {}) => {
        const student = this.connectedStudents.get(socket.id);
        if (student) {
          student.handRaised = Boolean(data.raised);
          this.connectedStudents.set(socket.id, student);
          this._emitStudentList();
        }
      });

      // ---------- Chat ----------
      socket.on('send-chat-message', (message) => {
        const chatMessage = {
          id: `${Date.now()}-${socket.id.slice(0, 6)}`,
          sender: (message && message.sender) || this.connectedStudents.get(socket.id)?.hostname || 'Desconocido',
          text: (message && message.text) || '',
          timestamp: Date.now()
        };
        this.emit('chat-message', chatMessage);
        this.io.emit('chat-message', chatMessage);
      });

      // ---------- Miniatura de pantalla (grilla, ~2s) ----------
      socket.on('student-screen-frame', (data = {}) => {
        const student = this.connectedStudents.get(socket.id);
        if (student) {
          student.screenFrame = data.dataUrl || null;
          this.connectedStudents.set(socket.id, student);
          this.emit('screen-frame', { socketId: socket.id, dataUrl: student.screenFrame });
          this.io.emit('student-thumbnail-update', {
            socketId: socket.id,
            dataUrl: student.screenFrame
          });
        }
      });

      // ---------- Señalización WebRTC (streaming en tiempo real) ----------
      socket.on('webrtc-signal', (data = {}) => {
        // El id virtual 'teacher' representa al proceso Maestro local.
        if (data.targetSocketId === 'teacher') {
          this.emit('webrtc-signal', {
            fromSocketId: socket.id,
            signal: data.signal
          });
        } else if (data.targetSocketId) {
          this.io.to(data.targetSocketId).emit('webrtc-signal', {
            fromSocketId: socket.id,
            signal: data.signal
          });
        }
      });

      // ---------- Gestor de archivos: comando del Maestro a un estudiante ----------
      socket.on('file-command', (data = {}) => {
        if (data.targetSocketId) {
          this.io.to(data.targetSocketId).emit('file-command', {
            fromSocketId: socket.id,
            requestId: data.requestId,
            action: data.action,
            path: data.path,
            content: data.content,
            filename: data.filename,
            data: data.data
          });
        }
      });

      // ---------- Gestor de archivos: respuesta del estudiante al Maestro ----------
      socket.on('file-response', (data = {}) => {
        if (data.targetSocketId === 'teacher' || data.targetSocketId === undefined) {
          this.emit('file-response', {
            studentSocketId: socket.id,
            requestId: data.requestId,
            action: data.action,
            result: data.result,
            error: data.error
          });
        }
      });

      // ---------- Error de captura de pantalla (estudiante -> Maestro) ----------
      socket.on('screen-capture-error', (data = {}) => {
        this.emit('screen-capture-error', {
          studentSocketId: socket.id,
          hostname: this.connectedStudents.get(socket.id)?.hostname || 'Desconocido',
          reason: data.reason || 'Error de captura de pantalla.'
        });
      });

      // ---------- Desconexión ----------
      socket.on('disconnect', () => {
        if (this.connectedStudents.delete(socket.id)) {
          this._emitStudentList();
        }
      });
    });
  }

  /**
   * Devuelve el array completo de estudiantes conectados.
   * @returns {Array<object>}
   */
  getStudentList() {
    return Array.from(this.connectedStudents.values());
  }

  _emitStudentList() {
    const list = this.getStudentList();
    this.io.emit('update-student-list', list);
    this.emit('student-list', list);
  }

  /**
   * Inicia el servidor HTTP en el puerto configurado.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.port, () => {
        console.log(`[server] Servidor Express + Socket.io escuchando en el puerto ${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Detiene el servidor y cierra todas las conexiones.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      const closeHttp = () => {
        this.httpServer.close(() => {
          console.log('[server] Servidor detenido.');
          resolve();
        });
      };
      try {
        this.io.close(closeHttp);
      } catch (err) {
        closeHttp();
      }
    });
  }
}

module.exports = MasterServer;
