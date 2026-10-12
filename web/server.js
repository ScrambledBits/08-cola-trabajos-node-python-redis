import { randomUUID } from 'node:crypto';
import express from 'express';
import { createClient } from 'redis';

const PORT = Number(process.env.PORT ?? 3000);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Contrato compartido con el worker (ver README).
const COLA = 'cola:trabajos';
const RECIENTES = 'trabajos:recientes';
const POR_WORKER = 'estadisticas:por_worker';
const claveTrabajo = (id) => `trabajo:${id}`;

const redis = createClient({ url: REDIS_URL }).on('error', (err) => console.error('Error de Redis:', err.message));
const app = express();

app.use(express.json({ limit: '50kb' }));
app.use(express.static('public'));

function formatear(id, datos) {
  return {
    id,
    estado: datos.estado,
    worker: datos.worker || null,
    creado_en: datos.creado_en,
    terminado_en: datos.terminado_en || null,
    resultado: datos.resultado ? JSON.parse(datos.resultado) : null,
  };
}

app.get('/health', async (_req, res) => {
  try {
    await redis.ping();
    res.json({ estado: 'ok', redis: 'conectado' });
  } catch {
    res.status(503).json({ estado: 'error', redis: 'sin conexion' });
  }
});

app.post('/api/trabajos', async (req, res) => {
  const texto = String(req.body?.texto ?? '').trim();
  if (!texto) return res.status(400).json({ error: 'El campo "texto" es obligatorio' });

  const id = randomUUID();
  await redis.hSet(claveTrabajo(id), { estado: 'pendiente', texto, creado_en: new Date().toISOString() });
  await redis.lPush(RECIENTES, id);
  await redis.lTrim(RECIENTES, 0, 19);
  await redis.lPush(COLA, id);
  res.status(202).json({ id, estado: 'pendiente' });
});

app.get('/api/trabajos', async (_req, res) => {
  const ids = await redis.lRange(RECIENTES, 0, -1);
  const trabajos = await Promise.all(ids.map(async (id) => formatear(id, await redis.hGetAll(claveTrabajo(id)))));
  res.json(trabajos);
});

app.get('/api/trabajos/:id', async (req, res) => {
  const datos = await redis.hGetAll(claveTrabajo(req.params.id));
  if (!datos.estado) return res.status(404).json({ error: 'Trabajo no encontrado' });
  res.json(formatear(req.params.id, datos));
});

app.get('/api/estadisticas', async (_req, res) => {
  const [pendientes, porWorker] = await Promise.all([redis.lLen(COLA), redis.hGetAll(POR_WORKER)]);
  res.json({
    en_cola: pendientes,
    procesados_por_worker: Object.fromEntries(Object.entries(porWorker).map(([k, v]) => [k, Number(v)])),
  });
});

await redis.connect();
console.log(`Conectado a Redis en ${REDIS_URL}`);
const servidor = app.listen(PORT, () => console.log(`Web escuchando en el puerto ${PORT}`));

for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => {
    console.log(`Recibida ${senal}, cerrando...`);
    servidor.close(() => {
      redis.destroy();
      process.exit(0);
    });
  });
}
