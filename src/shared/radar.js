const dgram = require('dgram');
const os = require('os');

// Constantes del protocolo de descubrimiento (compartidas entre Maestro y Estudiante)
const RADAR_PORT = 41234;
const MASTER_PORT = 3000;
const BROADCAST_INTERVAL_MS = 3000;
const SERVICE_NAME = 'AULA_CONTROL_MASTER';

/**
 * Devuelve todas las direcciones IPv4 no internas de la máquina.
 * Se utiliza para el filtrado de auto-identificación.
 * @returns {string[]}
 */
function getLocalIPv4Addresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();

  for (const ifaceName of Object.keys(interfaces)) {
    for (const iface of interfaces[ifaceName]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }

  return addresses;
}

/**
 * Emisor de radar UDP (solo Maestro).
 * Emite un paquete Broadcast JSON cada BROADCAST_INTERVAL_MS para que los
 * estudiantes de la red local descubran la dirección y el puerto del Maestro.
 */
class RadarBroadcaster {
  constructor({ instanceId, port = RADAR_PORT, intervalMs = BROADCAST_INTERVAL_MS }) {
    this.instanceId = instanceId;
    this.port = port;
    this.intervalMs = intervalMs;
    this.socket = null;
    this.timer = null;
  }

  start() {
    if (this.socket) {
      return;
    }

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('error', (err) => {
      console.error('[radar:broadcaster] Error de socket:', err.message);
      this.stop();
    });

    // Se enlaza a un puerto efímero (no a RADAR_PORT) para evitar conflictos.
    this.socket.bind(() => {
      this.socket.setBroadcast(true);
      this._announce();
      this.timer = setInterval(() => this._announce(), this.intervalMs);
    });
  }

  _announce() {
    if (!this.socket) {
      return;
    }

    const localIps = getLocalIPv4Addresses();
    const payload = JSON.stringify({
      service: SERVICE_NAME,
      port: MASTER_PORT,
      instanceId: this.instanceId,
      hostIp: localIps[0] || '127.0.0.1'
    });

    const message = Buffer.from(payload);
    this.socket.send(message, 0, message.length, this.port, '255.255.255.255', (err) => {
      if (err) {
        console.error('[radar:broadcaster] Error al enviar broadcast:', err.message);
      }
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.socket) {
      try {
        this.socket.close();
      } catch (err) {
        // El socket puede estar ya cerrado.
      }
      this.socket = null;
    }
  }
}

/**
 * Receptor de radar UDP (solo Estudiante).
 * Escucha en RADAR_PORT y, al recibir un anuncio válido de un Maestro,
 * invoca el callback onMasterDiscovered. Aplica un filtro estricto por
 * instanceId e IP local para evitar el bucle de auto-identificación.
 */
class RadarListener {
  constructor({ instanceId, port = RADAR_PORT, onMasterDiscovered }) {
    this.instanceId = instanceId;
    this.port = port;
    this.onMasterDiscovered = onMasterDiscovered || (() => {});
    this.socket = null;
    this.discoveredMasters = new Map();
  }

  start() {
    if (this.socket) {
      return;
    }

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('error', (err) => {
      console.error('[radar:listener] Error de socket:', err.message);
      this.stop();
    });

    this.socket.on('message', (message, remote) => {
      let data;
      try {
        data = JSON.parse(message.toString());
      } catch (err) {
        // Paquete que no corresponde al protocolo: se ignora silenciosamente.
        return;
      }

      if (!data || data.service !== SERVICE_NAME) {
        return;
      }

      // Filtro estricto de auto-identificación:
      // 1) Mismo instanceId (nuestro propio anuncio).
      // 2) IP de origen pertenece a esta máquina (bucle local).
      if (data.instanceId === this.instanceId) {
        return;
      }
      if (getLocalIPv4Addresses().includes(remote.address)) {
        return;
      }

      const masterInfo = {
        ip: remote.address,
        port: typeof data.port === 'number' ? data.port : MASTER_PORT,
        instanceId: data.instanceId,
        hostIp: data.hostIp || remote.address
      };

      // Evita notificar repetidamente al mismo maestro descubierto.
      const key = `${masterInfo.ip}:${masterInfo.port}`;
      if (this.discoveredMasters.has(key)) {
        return;
      }
      this.discoveredMasters.set(key, masterInfo);

      this.onMasterDiscovered(masterInfo);
    });

    this.socket.bind(this.port, () => {
      // En Windows es necesario habilitar broadcast explícitamente para escuchar.
      try {
        this.socket.setBroadcast(true);
      } catch (err) {
        // No es crítico si falla en plataformas que no lo soportan.
      }
    });
  }

  stop() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch (err) {
        // El socket puede estar ya cerrado.
      }
      this.socket = null;
    }
    this.discoveredMasters.clear();
  }
}

module.exports = {
  RADAR_PORT,
  MASTER_PORT,
  BROADCAST_INTERVAL_MS,
  SERVICE_NAME,
  getLocalIPv4Addresses,
  RadarBroadcaster,
  RadarListener
};
